import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { ItemOpcodes, NftVoucherItem } from '../wrappers/NftVoucherItem';
import { REDEEM_FORWARD_AMOUNT, RedeemerErrors, RedeemerOpcodes, VoucherRedeemer, voucherContentCell } from '../wrappers/VoucherRedeemer';
import { JettonWallet } from '../wrappers/Jetton';
import { buildRedeemMessage, contentHash as webContentHash } from '../web/src/payload';
import { loadNftCollectionCode, loadNftItemCode, NFT_COLLECTION_CODE_HASH, NFT_ITEM_CODE_HASH } from '../wrappers/nftVoucherCode';
import { GUM, giveJettons, installGumLibrary, jettonWalletAddress, OTHER_MASTER } from './helpers/gum';

const NFT_TON = toNano('1'); // TON locked inside each voucher

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
            responseDestination: who.address,
            forwardAmount,
            value: forwardAmount + toNano('0.05'),
        });

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
        const d = await redeemer.sendDeploy(admin.getSender(), toNano('0.1'));
        expect(d.transactions).toHaveTransaction({ to: redeemer.address, deploy: true, success: true });
        redeemerGum = await gumWallet(redeemer.address);
        await redeemer.sendSetJettonWallet(admin.getSender(), redeemerGum.address);
    });

    it('is configured', async () => {
        const data = await redeemer.getRedeemerData();
        expect(data.owner.equals(admin.address)).toBe(true);
        expect(data.collection.equals(collection.address)).toBe(true);
        expect(data.jettonWallet!.equals(redeemerGum.address)).toBe(true);
        expect(await redeemer.getDenomination('0.json')).toBe(GUM(10_000));
        expect(await redeemer.getDenomination('1.json')).toBe(GUM(5_000));
        expect(await redeemer.getDenomination('2.json')).toBe(GUM(1_000));
        expect(await redeemer.getDenomination('3.json')).toBe(0n);
        expect((await redeemer.getNftAddressByIndex(7)).equals(await collection.getNftAddressByIndex(7))).toBe(true);
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

    it('returns the voucher when too little TON is attached', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        await redeem(alice, nft, toNano('0.06'));
        expect((await nft.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(await gumOf(alice.address)).toBe(0n);
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
        const msg = buildRedeemMessage(nft.address.toString(), redeemer.address.toRawString(), alice.address.toString());
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

    it('0.05 TON attached to a GUM transfer is enough for the real GUM wallet', async () => {
        await depositGum(GUM(50_000));
        const nft = await mintVoucher(alice.address, '0.json');
        const res = await redeem(alice, nft);
        const aliceGum = jettonWalletAddress(alice.address);
        expect(res.transactions).toHaveTransaction({ from: redeemer.address, to: redeemerGum.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: redeemerGum.address, to: aliceGum, success: true, deploy: true });
        // the unused part of the 0.05 TON comes back to the user as jetton excess
        expect(res.transactions).toHaveTransaction({
            from: aliceGum,
            to: alice.address,
            op: ItemOpcodes.excesses,
            value: (v) => v! > toNano('0.03'),
        });
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

        it('restores tracked GUM if a withdrawal bounces', async () => {
            await depositGum(GUM(50_000));
            await redeemer.sendWithdrawJettons(admin.getSender(), redeemerGum.address, GUM(60_000)); // more than the wallet has
            expect((await redeemer.getRedeemerData()).gumBalance).toBe(GUM(50_000));
            expect(await redeemerGum.getBalance()).toBe(GUM(50_000));
        });

        it('withdraws all TON except the storage reserve', async () => {
            await depositGum(GUM(50_000));
            await redeem(alice, await mintVoucher(alice.address, '2.json'));
            const before = await tonOf(admin.address);
            await redeemer.sendWithdrawTon(admin.getSender());
            expect((await tonOf(admin.address)) - before).toBeGreaterThan(NFT_TON);
            expect(await tonOf(redeemer.address)).toBeLessThanOrEqual(toNano('0.05'));
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
                () => redeemer.sendChangeOwner(s, bob.address),
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

        it('transfers ownership', async () => {
            await redeemer.sendChangeOwner(admin.getSender(), bob.address);
            expect((await redeemer.getRedeemerData()).owner.equals(bob.address)).toBe(true);
        });
    });
});
