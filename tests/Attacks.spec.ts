// Adversarial tests: everything an attacker can send to the redeemer, plus things only the sandbox can do
// (spoofed sender addresses, interleaving two redemptions step by step). After each attack the invariants hold:
// counted GUM == GUM on the redeemer's wallet, the attacker has no GUM, no failed payouts, the redeemer's TON is not
// drained, and a voucher is never burned without its GUM.
import { Blockchain, BlockchainTransaction, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
// note: blockchain.sendMessageIter shares one queue, so it cannot interleave two redemptions; tests 8/8b use
// SmartContract.receiveMessage to run single transactions instead
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { ItemOpcodes, NftVoucherItem } from '../wrappers/NftVoucherItem';
import { OPERATING_RESERVE, REDEEM_FORWARD_AMOUNT, REDEEM_TX_AMOUNT, RedeemerErrors, RedeemerOpcodes, VoucherRedeemer, voucherContentCell } from '../wrappers/VoucherRedeemer';
import { JettonWallet } from '../wrappers/Jetton';
import { loadNftCollectionCode, loadNftItemCode } from '../wrappers/nftVoucherCode';
import { GUM, giveJettons, installGumLibrary, jettonWalletAddress } from './helpers/gum';

const VOUCHER_TON = toNano('0.19');
const POOL = GUM(1_000_000);
const JETTON_TRANSFER = 0x0f8a7ea5;
const TRANSFER_NOTIFICATION = 0x7362d09c;

describe('Attacks on the redeemer', () => {
    let code: Record<string, Cell> = {};
    beforeAll(async () => {
        code.VoucherRedeemer = await compile('VoucherRedeemer');
        code.NftVoucherItem = loadNftItemCode();
        code.NftVoucherCollection = loadNftCollectionCode();
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<NftVoucherCollection>;
    let redeemer: SandboxContract<VoucherRedeemer>;
    let nextIndex: number;

    const tonOf = async (a: Address) => (await blockchain.getContract(a)).balance;
    const gumOf = async (owner: Address) => blockchain.openContract(JettonWallet.createFromAddress(jettonWalletAddress(owner))).getBalance();
    const setTon = async (a: Address, v: bigint) => {
        (await blockchain.getContract(a)).balance = v;
    };
    const opOf = (tx: BlockchainTransaction) => {
        const s = tx.inMessage?.body.beginParse();
        return s && s.remainingBits >= 32 ? s.preloadUint(32) : -1;
    };
    const mintVoucher = async (owner: Address, content = '0.json', voucherValue = VOUCHER_TON, storageReserve?: bigint) => {
        const index = nextIndex++;
        await collection.sendMint(admin.getSender(), { itemIndex: index, itemOwner: owner, itemContent: content, voucherValue, storageReserve });
        return blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(index)));
    };
    /** exactly the redeem page transaction */
    const redeem = (who: SandboxContract<TreasuryContract>, nft: SandboxContract<NftVoucherItem>) =>
        nft.sendTransfer(who.getSender(), { newOwner: redeemer.address, responseDestination: null, forwardAmount: REDEEM_FORWARD_AMOUNT, value: REDEEM_TX_AMOUNT });
    const transferBody = (newOwner: Address, forward: bigint) =>
        beginCell().storeUint(ItemOpcodes.transfer, 32).storeUint(0, 64).storeAddress(newOwner).storeAddress(null).storeBit(false).storeCoins(forward).storeBit(false).endCell();
    const reportBody = (index: number, owner: Address | null, content: string, prevOwner: Address) =>
        beginCell()
            .storeUint(RedeemerOpcodes.reportVoucherData, 32)
            .storeUint(0, 64)
            .storeUint(index, 64)
            .storeAddress(owner)
            .storeRef(voucherContentCell(content))
            .storeRef(beginCell().storeAddress(prevOwner).endCell())
            .endCell();

    /** the invariants every attack must keep */
    const expectInvariants = async (tonBefore?: bigint) => {
        const data = await redeemer.getRedeemerData();
        expect(await gumOf(redeemer.address)).toBe(data.gumBalance); // counted == real
        expect(await gumOf(mallory.address)).toBe(0n);
        expect(data.failedPayouts).toBe(0);
        if (tonBefore !== undefined) expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(tonBefore);
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000; // frozen clock: no storage fee between transactions, so TON checks are exact
        admin = await blockchain.treasury('admin');
        alice = await blockchain.treasury('alice');
        mallory = await blockchain.treasury('mallory');
        nextIndex = 0;
        installGumLibrary(blockchain);
        await giveJettons(blockchain, admin.address, POOL);

        collection = blockchain.openContract(
            NftVoucherCollection.createFromConfig(
                {
                    ownerAddress: admin.address,
                    collectionContentUrl: 'https://cdn.gumcoin.org/vouchers/collection.json',
                    commonContentUrl: 'https://cdn.gumcoin.org/vouchers/',
                    nftItemCode: code.NftVoucherItem,
                    royaltyParams: { royaltyFactor: 0, royaltyBase: 100, royaltyAddress: admin.address },
                },
                code.NftVoucherCollection,
            ),
        );
        await collection.sendDeploy(admin.getSender(), toNano('0.05'));
        redeemer = blockchain.openContract(
            VoucherRedeemer.createFromConfig(
                {
                    owner: admin.address,
                    collection: collection.address,
                    nftItemCode: code.NftVoucherItem,
                    denominations: [
                        { content: '0.json', amount: GUM(10_000) },
                        { content: '2.json', amount: GUM(1_000) },
                    ],
                },
                code.VoucherRedeemer,
            ),
        );
        await redeemer.sendDeploy(admin.getSender(), OPERATING_RESERVE + toNano('0.1'));
        await redeemer.sendSetJettonWallet(admin.getSender(), jettonWalletAddress(redeemer.address));
        await blockchain
            .openContract(JettonWallet.createFromAddress(jettonWalletAddress(admin.address)))
            .sendTransfer(admin.getSender(), { to: redeemer.address, amount: POOL, forwardTonAmount: toNano('0.01') });
    });

    it('1. fake ownership_assigned (any value, garbage bodies): the request goes back to the attacker, paid with his TON', async () => {
        const before = await tonOf(redeemer.address);
        const bodies = [
            beginCell().storeUint(ItemOpcodes.ownershipAssigned, 32).storeUint(1, 64).storeAddress(alice.address).storeBit(false).endCell(),
            beginCell().storeUint(ItemOpcodes.ownershipAssigned, 32).storeUint(2, 64).endCell(), // truncated
            beginCell().storeUint(ItemOpcodes.ownershipAssigned, 32).storeUint(3, 64).storeUint(0, 2).endCell(), // addr_none prev owner
        ];
        for (const body of bodies) {
            for (const value of [toNano('0.001'), toNano('0.05'), toNano('1')]) {
                const res = await mallory.send({ to: redeemer.address, value, body });
                expect(res.transactions).not.toHaveTransaction({ from: redeemer.address, to: (a) => !a!.equals(mallory.address) });
            }
        }
        await expectInvariants(before);
    });

    it('2. forged report from the attacker, naming a real voucher that waits on the redeemer: rejected', async () => {
        const nft = await mintVoucher(alice.address);
        await nft.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: null }); // no forward: waits
        const before = await tonOf(redeemer.address);
        const res = await mallory.send({ to: redeemer.address, value: toNano('0.5'), body: reportBody(0, redeemer.address, '0.json', mallory.address) });
        expect(res.transactions).toHaveTransaction({ from: mallory.address, to: redeemer.address, exitCode: RedeemerErrors.notOurNft });
        expect(await nft.getIsBurned()).toBe(false);
        await expectInvariants(before);
    });

    it('3. replay of a genuine report captured from the NFT: rejected (the sender is not the NFT)', async () => {
        const nft = await mintVoucher(mallory.address);
        const ask = beginCell().storeUint(RedeemerOpcodes.requestVoucherData, 32).storeUint(0, 64).storeRef(beginCell().storeAddress(mallory.address).endCell()).endCell();
        const res = await mallory.send({ to: nft.address, value: toNano('0.05'), body: ask });
        const reply = res.transactions.find((t) => t.inMessage?.info.dest?.toString() === mallory.address.toString() && opOf(t) === RedeemerOpcodes.reportVoucherData)!;
        expect(reply).toBeDefined();
        const before = await tonOf(redeemer.address);
        const replay = await mallory.send({ to: redeemer.address, value: toNano('0.5'), body: reply.inMessage!.body });
        expect(replay.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notOurNft });
        await expectInvariants(before);
    });

    it('4. (sandbox only) a report really coming from the NFT, but the voucher still belongs to the attacker: rejected', async () => {
        // impossible on the real network (only the redeemer's own request makes the NFT reply to it) — defence in depth
        const nft = await mintVoucher(mallory.address);
        const before = await tonOf(redeemer.address);
        const res = await blockchain.sendMessage(internal({ from: nft.address, to: redeemer.address, value: toNano('0.05'), body: reportBody(0, mallory.address, '0.json', mallory.address) }));
        expect(res.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.nftNotOwned });
        expect(await nft.getIsBurned()).toBe(false);
        await expectInvariants(before);
    });

    it('5. forged GUM deposit notification (1e12 GUM) from the attacker: not counted', async () => {
        const body = beginCell().storeUint(TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(GUM(1_000_000_000_000)).storeAddress(mallory.address).storeBit(false).endCell();
        await mallory.send({ to: redeemer.address, value: toNano('0.05'), body });
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(POOL);
        await expectInvariants();
    });

    it('6. fake "bounced GUM transfer" body (to inflate the counted GUM): ignored', async () => {
        const body = beginCell().storeUint(0xffffffff, 32).storeUint(JETTON_TRANSFER, 32).storeUint(1, 64).storeCoins(GUM(1_000_000_000)).endCell();
        await mallory.send({ to: redeemer.address, value: toNano('0.05'), body, bounce: false });
        // even a (sandbox-only) real bounce from a non-GUM-wallet sender is ignored
        await blockchain.sendMessage(internal({ from: mallory.address, to: redeemer.address, value: toNano('0.05'), body, bounced: true }));
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(POOL);
        await expectInvariants();
    });

    it('7. double redemption: after the burn nothing pays a second time', async () => {
        const nft = await mintVoucher(mallory.address);
        await redeem(mallory, nft);
        expect(await nft.getIsBurned()).toBe(true);
        // the payout itself goes to mallory, so check the GUM by hand here
        expect(await gumOf(mallory.address)).toBe(GUM(10_000));
        const r1 = await nft.sendTransfer(mallory.getSender(), { newOwner: redeemer.address, responseDestination: null, forwardAmount: REDEEM_FORWARD_AMOUNT, value: REDEEM_TX_AMOUNT });
        expect(r1.transactions).toHaveTransaction({ to: nft.address, success: false }); // burned: owner is addr_none
        const fake = beginCell().storeUint(ItemOpcodes.ownershipAssigned, 32).storeUint(0, 64).storeAddress(mallory.address).storeBit(false).endCell();
        await mallory.send({ to: redeemer.address, value: toNano('0.05'), body: fake });
        // (sandbox only) even if the burned NFT itself answered again, it reports its real owner: addr_none
        const again = await blockchain.sendMessage(internal({ from: nft.address, to: redeemer.address, value: toNano('0.05'), body: reportBody(0, null, '0.json', mallory.address) }));
        expect(again.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.nftNotOwned });
        expect(await gumOf(mallory.address)).toBe(GUM(10_000));
        const data = await redeemer.getRedeemerData();
        expect(data.redeemedCount).toBe(1n);
        expect(await gumOf(redeemer.address)).toBe(data.gumBalance);
    });

    it('8. two reports processed before any burn refund, TON for only one payout: one is paid, the other voucher comes back', async () => {
        // Both vouchers wait on the redeemer (owner = redeemer), so their real NFTs would report exactly this.
        // The redeemer's transactions are run one by one WITHOUT delivering their messages, so the second report
        // sees the balance after the first payout and before the first burn refunds it.
        const v1 = await mintVoucher(alice.address);
        const v2 = await mintVoucher(alice.address);
        for (const v of [v1, v2]) await v.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: null });
        await setTon(redeemer.address, toNano('0.25')); // enough for exactly one payout (needs 0.18)
        const r = await blockchain.getContract(redeemer.address);
        const tx1 = await r.receiveMessage(internal({ from: v1.address, to: redeemer.address, value: toNano('0.014'), body: reportBody(0, redeemer.address, '0.json', alice.address) }));
        const tx2 = await r.receiveMessage(internal({ from: v2.address, to: redeemer.address, value: toNano('0.014'), body: reportBody(1, redeemer.address, '0.json', alice.address) }));
        const outOps = (tx: typeof tx1) => [...tx.outMessages.values()].map((m) => m.body.beginParse().preloadUint(32));
        expect(outOps(tx1)).toEqual([ItemOpcodes.destroy, JETTON_TRANSFER]); // burn + payout
        expect(outOps(tx2)).toEqual([ItemOpcodes.transfer]); // not enough TON left: voucher goes back, no burn
        expect(await tonOf(redeemer.address)).toBeGreaterThan(toNano('0.05')); // never below min_storage
        // now deliver everything
        for (const tx of [tx1, tx2]) for (const m of tx.outMessages.values()) await blockchain.sendMessage(m);
        expect(await v1.getIsBurned()).toBe(true);
        expect(await v2.getIsBurned()).toBe(false);
        expect((await v2.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(await gumOf(alice.address)).toBe(GUM(10_000));
        await expectInvariants();
    });

    it('8b. the same with almost no TON: neither report burns anything, both vouchers wait for rescue_nft', async () => {
        const v1 = await mintVoucher(alice.address);
        const v2 = await mintVoucher(alice.address);
        for (const v of [v1, v2]) await v.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: null });
        await setTon(redeemer.address, toNano('0.06'));
        const r = await blockchain.getContract(redeemer.address);
        for (const [i, v] of [v1, v2].entries()) {
            const tx = await r.receiveMessage(internal({ from: v.address, to: redeemer.address, value: toNano('0.014'), body: reportBody(i, redeemer.address, '0.json', alice.address) }));
            expect(tx.outMessagesCount).toBe(0);
        }
        expect([await v1.getIsBurned(), await v2.getIsBurned()]).toEqual([false, false]);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(POOL);
        await expectInvariants();
    });

    it('9. a huge forward_payload: the voucher is redeemed or waits, never burned without GUM', async () => {
        let payload = beginCell().storeUint(0, 1023).endCell();
        for (let i = 0; i < 50; i++) payload = beginCell().storeUint(i, 1000).storeRef(payload).endCell();
        const nft = await mintVoucher(alice.address);
        await nft.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: null, forwardAmount: toNano('0.1'), forwardPayload: payload, value: toNano('0.2') });
        if (await nft.getIsBurned()) expect(await gumOf(alice.address)).toBe(GUM(10_000));
        else expect(await gumOf(alice.address)).toBe(0n);
        await expectInvariants();
    });

    it('10. leaked operator key: 20 vouchers with ~no TON inside cost the redeemer < 0.01 TON each (GUM is the real loss)', async () => {
        const before = await tonOf(redeemer.address);
        for (let i = 0; i < 20; i++) await redeem(mallory, await mintVoucher(mallory.address, '2.json', 0n, toNano('0.01')));
        const lossPerVoucher = (before - (await tonOf(redeemer.address))) / 20n;
        expect(lossPerVoucher).toBeLessThan(toNano('0.01'));
        expect(await gumOf(mallory.address)).toBe(GUM(20_000)); // what a minting key can take: limit it in the minter
    });

    it('11. sending a voucher of an unknown kind around 10 times: costs the attacker, not the redeemer', async () => {
        const nft = await mintVoucher(mallory.address, '3.json');
        const before = await tonOf(redeemer.address);
        const malloryBefore = await tonOf(mallory.address);
        for (let i = 0; i < 10; i++) {
            await redeem(mallory, nft);
            expect((await nft.getNftData()).ownerAddress!.equals(mallory.address)).toBe(true);
        }
        expect(malloryBefore - (await tonOf(mallory.address))).toBeGreaterThan(toNano('0.25'));
        await expectInvariants(before);
    });

    it('12. a voucher of another collection with the same code: rejected', async () => {
        const evil = blockchain.openContract(
            NftVoucherCollection.createFromConfig(
                { ownerAddress: mallory.address, collectionContentUrl: 'x', commonContentUrl: 'y', nftItemCode: code.NftVoucherItem, royaltyParams: { royaltyFactor: 0, royaltyBase: 100, royaltyAddress: mallory.address } },
                code.NftVoucherCollection,
            ),
        );
        await evil.sendDeploy(mallory.getSender(), toNano('0.05'));
        await evil.sendMint(mallory.getSender(), { itemIndex: 0, itemOwner: mallory.address, itemContent: '0.json', voucherValue: toNano('0.01') });
        const fake = blockchain.openContract(NftVoucherItem.createFromAddress(await evil.getNftAddressByIndex(0)));
        const before = await tonOf(redeemer.address);
        const res = await redeem(mallory, fake);
        expect(res.transactions).toHaveTransaction({ from: fake.address, to: redeemer.address, exitCode: RedeemerErrors.notOurNft });
        await expectInvariants(before);
    });

    it('13. every owner operation from the attacker is refused', async () => {
        const s = mallory.getSender();
        const calls = [
            () => redeemer.sendWithdrawTon(s),
            () => redeemer.sendWithdrawTon(s, toNano('0.1')),
            () => redeemer.sendWithdrawJettons(s, jettonWalletAddress(redeemer.address), 1n),
            () => redeemer.sendSetPaused(s, true),
            () => redeemer.sendSetDenomination(s, '0.json', GUM(1_000_000)),
            () => redeemer.sendRescueNft(s, mallory.address, mallory.address),
            () => redeemer.sendProposeOwner(s, mallory.address),
            () => redeemer.sendSetJettonWallet(s, mallory.address),
        ];
        for (const call of calls) {
            expect((await call()).transactions).toHaveTransaction({ from: mallory.address, to: redeemer.address, exitCode: RedeemerErrors.notOwner });
        }
        expect((await redeemer.sendAcceptOwner(s)).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notPendingOwner });
        const data = await redeemer.getRedeemerData();
        expect(data.owner.equals(admin.address)).toBe(true);
        expect(data.paused).toBe(false);
        expect(await redeemer.getDenomination('0.json')).toBe(GUM(10_000));
        await expectInvariants();
    });

    it('14. bounced ownership_assigned / report / unknown ops and plain TON: nothing changes', async () => {
        const before = await tonOf(redeemer.address);
        await blockchain.sendMessage(internal({ from: mallory.address, to: redeemer.address, value: toNano('0.01'), bounced: true, body: beginCell().storeUint(0xffffffff, 32).storeUint(RedeemerOpcodes.reportVoucherData, 32).endCell() }));
        await mallory.send({ to: redeemer.address, value: toNano('0.01'), body: beginCell().storeUint(0x12345678, 32).storeUint(0, 64).endCell() });
        await mallory.send({ to: redeemer.address, value: toNano('0.01'), body: beginCell().storeUint(ItemOpcodes.excesses, 32).storeUint(0, 64).endCell() });
        await mallory.send({ to: redeemer.address, value: toNano('0.01') });
        await expectInvariants(before);
    });
});
