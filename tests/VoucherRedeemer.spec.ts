import { Blockchain, BlockchainTransaction, loadConfig, SandboxContract, TreasuryContract, updateConfig } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { ItemOpcodes, NftVoucherItem } from '../wrappers/NftVoucherItem';
import {
    MIN_REDEEM_BALANCE,
    OPERATING_RESERVE,
    REDEEM_FORWARD_AMOUNT,
    REDEEM_TX_AMOUNT,
    RedeemerErrors,
    RedeemerOpcodes,
    RedeemerQueryIds,
    VoucherRedeemer,
    voucherContentCell,
} from '../wrappers/VoucherRedeemer';
import { JettonWallet } from '../wrappers/Jetton';
import { buildRedeemMessage, contentHash as webContentHash, REDEEM_FORWARD_AMOUNT as WEB_FORWARD, REDEEM_TX_AMOUNT as WEB_TX_AMOUNT, REDEEMER_MIN_TON } from '../web/src/payload';
import { loadNftCollectionCode, loadNftItemCode, NFT_COLLECTION_CODE_HASH, NFT_ITEM_CODE_HASH, nftItemAddress } from '../wrappers/nftVoucherCode';
import { GUM, giveJettons, installGumLibrary, jettonWalletAddress, OTHER_MASTER } from './helpers/gum';

const NFT_TON = toNano('1'); // TON locked inside each voucher

/** Network fee changes: multiplies basechain gas and forward prices (config params 21 and 25). */
function scaleFees(blockchain: Blockchain, k: bigint) {
    const c = loadConfig(blockchain.config) as any;
    const g = c[21];
    const f = c[25];
    const gas = { ...g, anon0: { ...g.anon0, flat_gas_price: g.anon0.flat_gas_price * k, other: { ...g.anon0.other, gas_price: g.anon0.other.gas_price * k } } };
    const fwd = { ...f, anon0: { ...f.anon0, lump_price: f.anon0.lump_price * k, bit_price: f.anon0.bit_price * k, _cell_price: f.anon0._cell_price * k } };
    blockchain.setConfig(updateConfig(blockchain.config, gas, fwd));
}

describe('VoucherRedeemer', () => {
    let code: Record<string, Cell> = {};

    beforeAll(async () => {
        code.VoucherRedeemer = await compile('VoucherRedeemer');
        code.NftVoucherItem = loadNftItemCode();
        code.NftVoucherCollection = loadNftCollectionCode();
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<NftVoucherCollection>;
    let redeemer: SandboxContract<VoucherRedeemer>;
    let redeemerGum: SandboxContract<JettonWallet>;
    let nextIndex: number;

    const gumWallet = async (owner: Address) => blockchain.openContract(JettonWallet.createFromAddress(jettonWalletAddress(owner)));
    const gumOf = async (owner: Address) => (await gumWallet(owner)).getBalance();
    const tonOf = async (addr: Address) => (await blockchain.getContract(addr)).balance;
    /** query_id of the GUM transfers that bounced back from the redeemer's GUM wallet */
    const bouncedQueryIds = (txs: BlockchainTransaction[]) =>
        txs
            .filter((t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.bounced && t.inMessage.info.src.equals(redeemerGum.address))
            .map((t) => {
                const b = t.inMessage!.body.beginParse();
                b.skip(64); // 0xffffffff + op
                return b.loadUintBig(64);
            });

    const mintVoucher = async (owner: Address, content: string, voucherValue = NFT_TON) => {
        const index = nextIndex++;
        await collection.sendMint(admin.getSender(), { itemIndex: index, itemOwner: owner, itemContent: content, voucherValue });
        return blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(index)));
    };

    const depositGum = async (amount: bigint) => {
        const w = await gumWallet(admin.address);
        await w.sendTransfer(admin.getSender(), { to: redeemer.address, amount, forwardTonAmount: toNano('0.01') });
    };

    const redeem = (who: SandboxContract<TreasuryContract>, nft: SandboxContract<NftVoucherItem>, forwardAmount = REDEEM_FORWARD_AMOUNT) =>
        nft.sendTransfer(who.getSender(), {
            newOwner: redeemer.address,
            responseDestination: null, // as the redeem page: no excess back to the user
            forwardAmount,
            value: forwardAmount + (REDEEM_TX_AMOUNT - REDEEM_FORWARD_AMOUNT),
        });
    /** exactly what the redeem page hands to the wallet */
    const redeemViaPage = (who: SandboxContract<TreasuryContract>, nft: SandboxContract<NftVoucherItem>) => {
        const msg = buildRedeemMessage(nft.address.toString(), redeemer.address.toRawString());
        return who.send({ to: Address.parse(msg.address), value: BigInt(msg.amount), body: Cell.fromBoc(Buffer.from(msg.payload, 'base64'))[0] });
    };
    const setTon = async (addr: Address, v: bigint) => {
        (await blockchain.getContract(addr)).balance = v;
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        nextIndex = 0;

        // real GUM wallet code; admin already holds 1 000 000 GUM
        installGumLibrary(blockchain);
        await giveJettons(blockchain, admin.address, GUM(1_000_000));

        // voucher collection
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

        // redeemer
        redeemer = blockchain.openContract(
            VoucherRedeemer.createFromConfig(
                {
                    owner: admin.address,
                    collection: collection.address,
                    nftItemCode: code.NftVoucherItem,
                    denominations: [
                        { content: '0.json', amount: GUM(10_000) },
                        { content: '1.json', amount: GUM(5_000) },
                        { content: '2.json', amount: GUM(1_000) },
                    ],
                },
                code.VoucherRedeemer,
            ),
        );
        const d = await redeemer.sendDeploy(admin.getSender(), OPERATING_RESERVE + toNano('0.1')); // as deployRedeemer
        expect(d.transactions).toHaveTransaction({ to: redeemer.address, deploy: true, success: true });
        redeemerGum = await gumWallet(redeemer.address);
        await redeemer.sendSetJettonWallet(admin.getSender(), redeemerGum.address);
    });

    it('is configured', async () => {
        const data = await redeemer.getRedeemerData();
        expect(data.owner.equals(admin.address)).toBe(true);
        expect(data.collection.equals(collection.address)).toBe(true);
        expect(data.jettonWallet!.equals(redeemerGum.address)).toBe(true);
        expect(data.pendingOwner).toBeNull();
        expect(data.failedPayouts).toBe(0);
        expect(await redeemer.getDenomination('0.json')).toBe(GUM(10_000));
        expect(await redeemer.getDenomination('1.json')).toBe(GUM(5_000));
        expect(await redeemer.getDenomination('2.json')).toBe(GUM(1_000));
        expect(await redeemer.getDenomination('3.json')).toBe(0n);
        expect((await redeemer.getNftAddressByIndex(7)).equals(await collection.getNftAddressByIndex(7))).toBe(true);
        expect(nftItemAddress(collection.address, 7n).equals(await collection.getNftAddressByIndex(7))).toBe(true); // deployRedeemer pre-check
    });

    it('counts GUM deposits sent with notification', async () => {
        await depositGum(GUM(50_000));
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
        expect(await redeemerGum.getBalance()).toBe(GUM(50_000));
    });

    it.each([
        ['0.json', 10_000],
        ['1.json', 5_000],
        ['2.json', 1_000],
    ])('redeems %s for %i GUM, burns the NFT and takes its TON', async (content, amount) => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, content);
        const redeemerTonBefore = await tonOf(redeemer.address);

        const res = await redeem(alice, nft);

        // NFT gave its whole balance to the redeemer
        expect(res.transactions).toHaveTransaction({
            from: nft.address,
            to: redeemer.address,
            op: ItemOpcodes.excesses,
            value: (v) => v! >= NFT_TON,
        });
        expect(await nft.getIsBurned()).toBe(true);
        expect(await tonOf(nft.address)).toBe(0n);
        expect(await gumOf(alice.address)).toBe(GUM(amount));

        const data = await redeemer.getRedeemerData();
        expect(data.gumBalance).toBe(GUM(50_000 - amount));
        expect(data.redeemedCount).toBe(1n);
        expect(await redeemerGum.getBalance()).toBe(GUM(50_000 - amount));
        // redeemer earned roughly the NFT TON
        expect((await tonOf(redeemer.address)) - redeemerTonBefore).toBeGreaterThan(NFT_TON - toNano('0.1'));
    });

    it('a voucher bought from someone else is paid to the current owner', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '1.json');
        await nft.sendTransfer(alice.getSender(), { newOwner: bob.address, responseDestination: alice.address });
        await redeem(bob, nft);
        expect(await gumOf(bob.address)).toBe(GUM(5_000));
        expect(await gumOf(alice.address)).toBe(0n);
    });

    it('returns the voucher when there is not enough GUM', async () => {
        await depositGum(GUM(3_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await redeem(alice, nft);
        expect(await nft.getIsBurned()).toBe(false);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(await tonOf(nft.address)).toBeGreaterThanOrEqual(NFT_TON);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(3_000));
        expect(await gumOf(alice.address)).toBe(0n);
    });

    it('returns the voucher while paused, redeems after unpause', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '2.json');
        await redeemer.sendSetPaused(admin.getSender(), true);
        await redeem(alice, nft);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);

        await redeemer.sendSetPaused(admin.getSender(), false);
        await redeem(alice, nft);
        expect(await nft.getIsBurned()).toBe(true);
        expect(await gumOf(alice.address)).toBe(GUM(1_000));
    });

    it('returns a voucher of an unknown kind', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '3.json');
        await redeem(alice, nft);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
    });

    it('the page and the wrapper attach the same small amounts', () => {
        expect(WEB_FORWARD).toBe(REDEEM_FORWARD_AMOUNT);
        expect(WEB_TX_AMOUNT).toBe(REDEEM_TX_AMOUNT);
        expect(REDEEMER_MIN_TON).toBe(MIN_REDEEM_BALANCE);
        expect(REDEEM_TX_AMOUNT).toBeLessThanOrEqual(toNano('0.03'));
    });

    it('with a forward_amount too small for the notification the voucher waits on the redeemer, it is never burned', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await redeem(alice, nft, toNano('0.0005'));
        expect(await nft.getIsBurned()).toBe(false);
        expect((await nft.getNftData()).ownerAddress!.equals(redeemer.address)).toBe(true);
        expect(await gumOf(alice.address)).toBe(0n);
        await redeemer.sendRescueNft(admin.getSender(), nft.address, alice.address);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
    });

    it.each([1n, 3n, 10n])('network fees x%i: a voucher is never burned without its GUM', async (k) => {
        await depositGum(GUM(1_000_000));
        scaleFees(blockchain, k);
        const outcomes: string[] = [];
        for (const fwd of ['0.0005', '0.001', '0.002', '0.003', '0.005', '0.008', '0.015', '0.03']) {
            const nft = await mintVoucher(alice.address, '2.json');
            const gumBefore = await gumOf(alice.address);
            const forwardAmount = toNano(fwd);
            await nft.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: null, forwardAmount, value: forwardAmount + toNano('0.011') * k + toNano('0.01') });
            const burned = await nft.getIsBurned();
            const gotGum = (await gumOf(alice.address)) - gumBefore;
            if (burned) {
                expect(gotGum).toBe(GUM(1_000)); // burned => paid
                outcomes.push('redeemed');
            } else {
                expect(gotGum).toBe(0n);
                const owner = (await nft.getNftData()).ownerAddress!;
                outcomes.push(owner.equals(alice.address) ? 'not sent' : 'waits for rescue');
            }
        }
        expect((await redeemer.getRedeemerData()).failedPayouts).toBe(0);
        if (k <= 3n) expect(outcomes[outcomes.length - 2]).toBe('redeemed'); // the page amount works with fees x3
    });

    it('with fees x3 the page transaction still redeems', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        scaleFees(blockchain, 3n);
        await redeemViaPage(alice, nft);
        expect(await nft.getIsBurned()).toBe(true);
        expect(await gumOf(alice.address)).toBe(GUM(10_000));
    });

    it('without enough TON on the redeemer the voucher is returned, not burned', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await setTon(redeemer.address, MIN_REDEEM_BALANCE - toNano('0.02'));
        await redeemViaPage(alice, nft);
        expect(await nft.getIsBurned()).toBe(false);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
        expect(await gumOf(alice.address)).toBe(0n);
    });

    it('with no TON even for a return the voucher waits on the redeemer for rescue_nft', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await setTon(redeemer.address, toNano('0.06'));
        await redeemViaPage(alice, nft);
        expect(await nft.getIsBurned()).toBe(false);
        expect((await nft.getNftData()).ownerAddress!.equals(redeemer.address)).toBe(true);
        await admin.send({ to: redeemer.address, value: toNano('1') });
        await redeemer.sendRescueNft(admin.getSender(), nft.address, alice.address);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
    });

    it('fake ownership_assigned notifications cost the redeemer nothing', async () => {
        await depositGum(GUM(50_000));
        const before = await tonOf(redeemer.address);
        for (let i = 0; i < 20; i++) {
            const body = beginCell().storeUint(ItemOpcodes.ownershipAssigned, 32).storeUint(i, 64).storeAddress(bob.address).storeBit(false).endCell();
            await bob.send({ to: redeemer.address, value: toNano('0.01'), body });
        }
        expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(before);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
    });

    it('a forged report costs the redeemer nothing', async () => {
        await depositGum(GUM(50_000));
        const before = await tonOf(redeemer.address);
        const forged = beginCell()
            .storeUint(RedeemerOpcodes.reportVoucherData, 32)
            .storeUint(0, 64)
            .storeUint(0, 64)
            .storeAddress(redeemer.address)
            .storeRef(voucherContentCell('0.json'))
            .storeRef(beginCell().storeAddress(bob.address).endCell())
            .endCell();
        for (const value of [toNano('0.001'), toNano('0.01'), toNano('1')]) {
            await bob.send({ to: redeemer.address, value, body: forged });
        }
        expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(before);
    });

    it('sending a voucher around while paused costs the sender, not the redeemer', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await redeemer.sendSetPaused(admin.getSender(), true);
        const redeemerBefore = await tonOf(redeemer.address);
        const aliceBefore = await tonOf(alice.address);
        for (let i = 0; i < 5; i++) {
            await redeemViaPage(alice, nft);
            expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        }
        expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(redeemerBefore);
        expect(aliceBefore - (await tonOf(alice.address))).toBeGreaterThan(toNano('0.1')); // ~0.03 per round
    });

    it('a returned voucher costs the redeemer nothing: the return excess comes back to it', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '3.json'); // unknown kind
        const before = await tonOf(redeemer.address);
        const res = await redeemViaPage(alice, nft);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(res.transactions).toHaveTransaction({ from: nft.address, to: redeemer.address, op: ItemOpcodes.excesses });
        expect(res.transactions).not.toHaveTransaction({ from: nft.address, to: alice.address, op: ItemOpcodes.excesses });
        expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(before);
    });

    it('voucher sent without forward_amount can be rescued by the owner', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await nft.sendTransfer(alice.getSender(), { newOwner: redeemer.address, responseDestination: alice.address });
        expect((await nft.getNftData()).ownerAddress!.equals(redeemer.address)).toBe(true);

        expect((await redeemer.sendRescueNft(bob.getSender(), nft.address, bob.address)).transactions).toHaveTransaction({
            to: redeemer.address,
            exitCode: RedeemerErrors.notOwner,
        });
        await redeemer.sendRescueNft(admin.getSender(), nft.address, alice.address);
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
    });

    it('rejects a forged report from a non-collection contract', async () => {
        await depositGum(GUM(50_000));
        const forged = beginCell()
            .storeUint(RedeemerOpcodes.reportVoucherData, 32)
            .storeUint(0, 64)
            .storeUint(0, 64)
            .storeAddress(redeemer.address)
            .storeRef(voucherContentCell('0.json'))
            .storeRef(beginCell().storeAddress(bob.address).endCell())
            .endCell();
        const res = await bob.send({ to: redeemer.address, value: toNano('0.2'), body: forged });
        expect(res.transactions).toHaveTransaction({ from: bob.address, to: redeemer.address, success: false, exitCode: RedeemerErrors.notOurNft });
        expect(await gumOf(bob.address)).toBe(0n);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
    });

    it('ignores vouchers of a different collection with the same code', async () => {
        await depositGum(GUM(50_000));
        const fakeCollection = blockchain.openContract(
            NftVoucherCollection.createFromConfig(
                {
                    ownerAddress: bob.address,
                    collectionContentUrl: 'https://evil/collection.json',
                    commonContentUrl: 'https://cdn.gumcoin.org/vouchers/',
                    nftItemCode: code.NftVoucherItem,
                    royaltyParams: { royaltyFactor: 0, royaltyBase: 100, royaltyAddress: bob.address },
                },
                code.NftVoucherCollection,
            ),
        );
        await fakeCollection.sendDeploy(bob.getSender(), toNano('0.05'));
        await fakeCollection.sendMint(bob.getSender(), { itemIndex: 0, itemOwner: bob.address, itemContent: '0.json', voucherValue: toNano('0.1') });
        const fake = blockchain.openContract(NftVoucherItem.createFromAddress(await fakeCollection.getNftAddressByIndex(0)));

        const res = await redeem(bob, fake);
        expect(res.transactions).toHaveTransaction({ from: fake.address, to: redeemer.address, op: RedeemerOpcodes.reportVoucherData, exitCode: RedeemerErrors.notOurNft });
        expect(await gumOf(bob.address)).toBe(0n);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
    });

    it('ignores jettons that are not GUM', async () => {
        const bobOther = blockchain.openContract(JettonWallet.createFromAddress(await giveJettons(blockchain, bob.address, GUM(100_000), OTHER_MASTER)));
        await bobOther.sendTransfer(bob.getSender(), { to: redeemer.address, amount: GUM(100_000), forwardTonAmount: toNano('0.01') });
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(0n);

        // ...and the owner can still take them out
        const redeemerOther = jettonWalletAddress(redeemer.address, OTHER_MASTER);
        await redeemer.sendWithdrawJettons(admin.getSender(), redeemerOther, GUM(100_000));
        const adminOther = blockchain.openContract(JettonWallet.createFromAddress(jettonWalletAddress(admin.address, OTHER_MASTER)));
        expect(await adminOther.getBalance()).toBe(GUM(100_000));
    });

    it('the web page transaction (TON Connect message) redeems a voucher', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '1.json');
        // exactly what the page hands to the wallet: address, amount string, base64 BOC payload
        const msg = buildRedeemMessage(nft.address.toString(), redeemer.address.toRawString());
        await alice.send({
            to: Address.parse(msg.address),
            value: BigInt(msg.amount),
            body: Cell.fromBoc(Buffer.from(msg.payload, 'base64'))[0],
        });
        expect(await nft.getIsBurned()).toBe(true);
        expect(await gumOf(alice.address)).toBe(GUM(5_000));
        // the page finds the GUM amount by the same content hash the redeemer uses
        for (const k of ['0.json', '1.json', '2.json']) {
            expect(webContentHash(k)).toBe(BigInt('0x' + voucherContentCell(k).hash().toString('hex')));
        }
    });

    it('the redeemer pays the GUM transfer to the real GUM wallet; the unused part comes back to the redeemer', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        const res = await redeemViaPage(alice, nft);
        const aliceGum = jettonWalletAddress(alice.address);
        expect(res.transactions).toHaveTransaction({ from: redeemer.address, to: redeemerGum.address, success: true, value: toNano('0.1') });
        expect(res.transactions).toHaveTransaction({ from: redeemerGum.address, to: aliceGum, success: true, deploy: true });
        // the unused TON is the jetton excess, and it goes to the redeemer, not to the user
        expect(res.transactions).toHaveTransaction({
            from: aliceGum,
            to: redeemer.address,
            op: ItemOpcodes.excesses,
            value: (v) => v! > toNano('0.09'),
        });
        expect(res.transactions).not.toHaveTransaction({ from: aliceGum, to: alice.address, op: ItemOpcodes.excesses });
    });

    it('the user gets only GUM: the attached TON and the TON inside the voucher go to the redeemer', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '1.json');
        const voucherTon = await tonOf(nft.address);
        const aliceBefore = await tonOf(alice.address);
        const redeemerBefore = await tonOf(redeemer.address);
        const msg = buildRedeemMessage(nft.address.toString(), redeemer.address.toRawString());
        const res = await alice.send({ to: Address.parse(msg.address), value: BigInt(msg.amount), body: Cell.fromBoc(Buffer.from(msg.payload, 'base64'))[0] });
        expect(await gumOf(alice.address)).toBe(GUM(5_000));
        // no TON comes back to the user, except the 1 nanoTON that carries the "Gumcoin voucher redeemed" comment
        const toAlice = res.transactions.filter((t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(alice.address));
        expect(toAlice.length).toBeGreaterThan(0); // the jetton notification
        for (const t of toAlice) {
            expect((t.inMessage!.info as { value: { coins: bigint } }).value.coins).toBeLessThanOrEqual(1n);
        }
        const attached = BigInt(msg.amount);
        const aliceSpent = aliceBefore - (await tonOf(alice.address));
        expect(aliceSpent).toBeGreaterThanOrEqual(attached);
        expect(aliceSpent).toBeLessThan(attached + toNano('0.01')); // + her wallet's own fee
        // the redeemer keeps the voucher TON and the attached TON, minus network fees of the whole chain
        const redeemerGain = (await tonOf(redeemer.address)) - redeemerBefore;
        expect(redeemerGain).toBeGreaterThan(voucherTon + attached - toNano('0.02'));
        expect(redeemerGain).toBeLessThan(voucherTon + attached);
    });

    it('a returned voucher keeps the unused attached TON inside it, nothing is lost', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        const before = await tonOf(nft.address);
        await redeemer.sendSetPaused(admin.getSender(), true);
        const msg = buildRedeemMessage(nft.address.toString(), redeemer.address.toRawString());
        await alice.send({ to: Address.parse(msg.address), value: BigInt(msg.amount), body: Cell.fromBoc(Buffer.from(msg.payload, 'base64'))[0] });
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(await tonOf(nft.address)).toBeGreaterThan(before); // what was left of the attached TON after forward + NFT gas
    });

    it('a voucher from a masterchain owner stays on the redeemer (no burn, no payout); the owner can rescue it', async () => {
        await depositGum(GUM(50_000));
        const mc = await blockchain.treasury('mc-user', { workchain: -1 });
        const nft = await mintVoucher(mc.address, '0.json'); // only the collection owner can mint to a -1 address
        // without response_destination (the item itself refuses a -1 one)
        const res = await nft.sendTransfer(mc.getSender(), { newOwner: redeemer.address, forwardAmount: REDEEM_FORWARD_AMOUNT, value: toNano('0.3') });
        expect(res.transactions).toHaveTransaction({ from: nft.address, to: redeemer.address, op: RedeemerOpcodes.reportVoucherData, success: true });
        expect(await nft.getIsBurned()).toBe(false);
        expect((await nft.getNftData()).ownerAddress!.equals(redeemer.address)).toBe(true);
        const data = await redeemer.getRedeemerData();
        expect([data.gumBalance, data.redeemedCount, data.failedPayouts]).toEqual([GUM(50_000), 0n, 0]);
        await redeemer.sendRescueNft(admin.getSender(), nft.address, alice.address); // e.g. to the user's basechain wallet
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
    });

    it('a voucher minted straight to the redeemer with a notification is not paid (prev_owner = collection)', async () => {
        await depositGum(GUM(50_000));
        const nftContent = beginCell().storeAddress(redeemer.address).storeRef(voucherContentCell('0.json')).storeCoins(REDEEM_FORWARD_AMOUNT).storeBit(false).endCell();
        const amount = toNano('0.4');
        const mint = beginCell().storeUint(1, 32).storeUint(0, 64).storeUint(nextIndex++, 64).storeCoins(amount).storeRef(nftContent).endCell();
        const res = await admin.send({ to: collection.address, value: amount + toNano('0.1'), body: mint });
        const nft = blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(0)));
        expect(res.transactions).toHaveTransaction({ from: nft.address, to: redeemer.address, op: RedeemerOpcodes.reportVoucherData, success: true });
        expect(await nft.getIsBurned()).toBe(false);
        expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
        expect(await gumOf(collection.address)).toBe(0n);
    });

    it('a payout that bounces restores the tracked GUM and is counted; its query_id is the voucher index', async () => {
        await depositGum(GUM(50_000));
        await mintVoucher(bob.address, '2.json'); // index 0
        const nft = await mintVoucher(alice.address, '0.json'); // index 1
        await giveJettons(blockchain, redeemer.address, 0n); // simulate: the GUM are not on the wallet any more
        const res = await redeem(alice, nft);
        expect(bouncedQueryIds(res.transactions)).toEqual([1n]); // the voucher index
        expect(await nft.getIsBurned()).toBe(true); // the burn is not undone
        expect(await gumOf(alice.address)).toBe(0n);
        const data = await redeemer.getRedeemerData();
        expect([data.gumBalance, data.failedPayouts]).toEqual([GUM(50_000), 1]);
    });

    it('uses the pinned nft-voucher code', () => {
        expect(code.NftVoucherItem.hash().toString('hex')).toBe(NFT_ITEM_CODE_HASH);
        expect(code.NftVoucherCollection.hash().toString('hex')).toBe(NFT_COLLECTION_CODE_HASH);
    });

    describe('owner', () => {
        it('withdraws GUM', async () => {
            await depositGum(GUM(50_000));
            const before = await gumOf(admin.address);
            await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(20_000));
            expect(await gumOf(admin.address)).toBe(before + GUM(20_000));
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(30_000));
        });

        it('withdraws GUM that arrived without a notification too (tracked GUM first)', async () => {
            await depositGum(GUM(50_000));
            await (await gumWallet(admin.address)).sendTransfer(admin.getSender(), { to: redeemer.address, amount: GUM(10_000) }); // not counted
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
            const before = await gumOf(admin.address);
            await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(60_000));
            expect(await gumOf(admin.address)).toBe(before + GUM(60_000));
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(0n);
            expect(await redeemerGum.getBalance()).toBe(0n);
        });

        it('a withdrawal larger than the wallet holds: the tracked GUM arrive, the rest bounces', async () => {
            await depositGum(GUM(50_000));
            const before = await gumOf(admin.address);
            const res = await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(60_000));
            expect(bouncedQueryIds(res.transactions)).toEqual([RedeemerQueryIds.withdrawOther]); // only the untracked part bounced
            expect(await gumOf(admin.address)).toBe(before + GUM(50_000));
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(0n);
            expect(await redeemerGum.getBalance()).toBe(0n);
        });

        it('restores the tracked GUM if a withdrawal of tracked GUM bounces', async () => {
            await depositGum(GUM(50_000));
            await giveJettons(blockchain, redeemer.address, GUM(10_000)); // simulate: the wallet holds less than tracked
            const res = await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(20_000));
            expect(bouncedQueryIds(res.transactions)).toEqual([RedeemerQueryIds.withdrawTracked]);
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
        });

        it('withdraws more than 2^64 units (~18.45 bn GUM) in one call', async () => {
            await giveJettons(blockchain, bob.address, GUM(20_000_000_000));
            await (await gumWallet(bob.address)).sendTransfer(bob.getSender(), { to: redeemer.address, amount: GUM(20_000_000_000), forwardTonAmount: toNano('0.01') });
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(20_000_000_000));
            const before = await gumOf(admin.address);
            await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(20_000_000_000));
            expect(await gumOf(admin.address)).toBe(before + GUM(20_000_000_000));
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(0n);
        });

        it('while active, "withdraw all" leaves the operating reserve and redemptions keep working', async () => {
            await depositGum(GUM(50_000));
            await redeem(alice, await mintVoucher(alice.address, '2.json'));
            const before = await tonOf(admin.address);
            await redeemer.sendWithdrawTon(admin.getSender());
            expect((await tonOf(admin.address)) - before).toBeGreaterThan(NFT_TON - toNano('0.1'));
            expect(await tonOf(redeemer.address)).toBeGreaterThanOrEqual(OPERATING_RESERVE - toNano('0.01'));
            expect(await tonOf(redeemer.address)).toBeLessThanOrEqual(OPERATING_RESERVE);
            const nft = await mintVoucher(alice.address, '2.json');
            await redeemViaPage(alice, nft);
            expect(await nft.getIsBurned()).toBe(true);
            // a fixed amount that would go below the reserve is refused (the redemption above refilled the balance)
            const excess = (await tonOf(redeemer.address)) - OPERATING_RESERVE;
            const tooMuch = await redeemer.sendWithdrawTon(admin.getSender(), excess + toNano('0.05'));
            expect(tooMuch.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notEnoughTon });
        });

        it('when paused, everything except the storage reserve can be withdrawn; unpausing requires the operating reserve', async () => {
            await depositGum(GUM(50_000));
            await redeemer.sendSetPaused(admin.getSender(), true);
            await redeemer.sendWithdrawTon(admin.getSender());
            expect(await tonOf(redeemer.address)).toBeLessThanOrEqual(toNano('0.05'));
            const res = await redeemer.sendSetPaused(admin.getSender(), false);
            expect(res.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notEnoughTon });
            expect((await redeemer.getRedeemerData()).paused).toBe(true);
            await admin.send({ to: redeemer.address, value: OPERATING_RESERVE });
            await redeemer.sendSetPaused(admin.getSender(), false);
            expect((await redeemer.getRedeemerData()).paused).toBe(false);
        });

        it('withdraws a fixed TON amount', async () => {
            await admin.send({ to: redeemer.address, value: toNano('3') });
            const before = await tonOf(admin.address);
            await redeemer.sendWithdrawTon(admin.getSender(), toNano('2'));
            expect((await tonOf(admin.address)) - before).toBeGreaterThan(toNano('1.9'));
            const tooMuch = await redeemer.sendWithdrawTon(admin.getSender(), toNano('100'));
            expect(tooMuch.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notEnoughTon });
        });

        it('only the owner can manage the contract', async () => {
            const s = bob.getSender();
            const calls = [
                () => redeemer.sendWithdrawTon(s),
                () => redeemer.sendWithdrawJettons(s, redeemerGum.address, 1n),
                () => redeemer.sendSetPaused(s, true),
                () => redeemer.sendSetDenomination(s, '0.json', GUM(1)),
                () => redeemer.sendProposeOwner(s, bob.address),
                () => redeemer.sendRescueNft(s, bob.address, bob.address),
            ];
            for (const call of calls) {
                expect((await call()).transactions).toHaveTransaction({ from: bob.address, to: redeemer.address, exitCode: RedeemerErrors.notOwner });
            }
        });

        it('jetton wallet can be set only once', async () => {
            const res = await redeemer.sendSetJettonWallet(admin.getSender(), bob.address);
            expect(res.transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.jettonWalletAlreadySet });
        });

        it('changes GUM amount of a kind', async () => {
            await depositGum(GUM(50_000));
            await redeemer.sendSetDenomination(admin.getSender(), '2.json', GUM(1_500));
            await redeem(alice, await mintVoucher(alice.address, '2.json'));
            expect(await gumOf(alice.address)).toBe(GUM(1_500));
        });

        it('ownership changes in two steps', async () => {
            await redeemer.sendProposeOwner(admin.getSender(), bob.address);
            let data = await redeemer.getRedeemerData();
            expect(data.owner.equals(admin.address)).toBe(true);
            expect(data.pendingOwner!.equals(bob.address)).toBe(true);
            // nobody else can accept, and the proposed owner cannot manage yet
            expect((await redeemer.sendAcceptOwner(alice.getSender())).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notPendingOwner });
            expect((await redeemer.sendSetPaused(bob.getSender(), true)).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notOwner });

            await redeemer.sendAcceptOwner(bob.getSender());
            data = await redeemer.getRedeemerData();
            expect(data.owner.equals(bob.address)).toBe(true);
            expect(data.pendingOwner).toBeNull();
            expect((await redeemer.sendSetPaused(admin.getSender(), true)).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notOwner });
            await redeemer.sendSetPaused(bob.getSender(), true);
            expect((await redeemer.getRedeemerData()).paused).toBe(true);
        });

        it('a pending owner change can be cancelled; only basechain addresses can be proposed', async () => {
            await redeemer.sendProposeOwner(admin.getSender(), bob.address);
            await redeemer.sendProposeOwner(admin.getSender(), null);
            expect((await redeemer.sendAcceptOwner(bob.getSender())).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.notPendingOwner });
            const mc = await blockchain.treasury('mc', { workchain: -1 });
            expect((await redeemer.sendProposeOwner(admin.getSender(), mc.address)).transactions).toHaveTransaction({ to: redeemer.address, exitCode: RedeemerErrors.badAddress });
            expect((await redeemer.getRedeemerData()).owner.equals(admin.address)).toBe(true);
        });

        it('the jetton wallet must be a basechain address', async () => {
            const fresh = blockchain.openContract(
                VoucherRedeemer.createFromConfig({ owner: admin.address, collection: collection.address, nftItemCode: code.NftVoucherItem, denominations: [] }, code.VoucherRedeemer),
            );
            await fresh.sendDeploy(admin.getSender(), toNano('0.1'));
            const mc = await blockchain.treasury('mc', { workchain: -1 });
            expect((await fresh.sendSetJettonWallet(admin.getSender(), mc.address)).transactions).toHaveTransaction({ to: fresh.address, exitCode: RedeemerErrors.badAddress });
            expect((await fresh.getRedeemerData()).jettonWallet).toBeNull();
        });
    });
});
