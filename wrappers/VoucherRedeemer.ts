import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';

export const RedeemerOpcodes = {
    setJettonWallet: 0x18cb206a,
    setDenomination: 0x421c9bac,
    withdrawTon: 0x30ee853f,
    withdrawJettons: 0x7bd18a75,
    rescueNft: 0x239c982e,
    proposeOwner: 0x027ced09,
    acceptOwner: 0x7d5cdfed,
    setPaused: 0x00dc73fc,
    requestVoucherData: 0x6d2e6461,
    reportVoucherData: 0x7d85c51d,
};

export const RedeemerErrors = {
    notOwner: 401,
    notOurNft: 403,
    nftNotOwned: 404,
    jettonWalletAlreadySet: 405,
    notEnoughTon: 406,
    notPendingOwner: 408,
    badAddress: 409,
    unknownOp: 0xffff,
};

/** query_id of the redeemer's jetton transfers (a voucher payout uses the voucher index). */
export const RedeemerQueryIds = {
    withdrawTracked: 0x8000000000000000n,
    withdrawOther: 0x8000000000000001n,
};

/** TON the user must attach as forward_amount when sending a voucher to the redeemer. */
export const REDEEM_FORWARD_AMOUNT = toNano('0.15');

/** Item content cell exactly as the collection stores it: suffix like "0.json". */
export function voucherContentCell(suffix: string): Cell {
    return beginCell().storeStringTail(suffix).endCell();
}

export type Denomination = { content: string; amount: bigint };

export type VoucherRedeemerConfig = {
    owner: Address;
    collection: Address;
    nftItemCode: Cell;
    denominations: Denomination[]; // amount in jetton units (GUM * 10^decimals)
    jettonWallet?: Address | null;
    paused?: boolean;
};

export function voucherRedeemerConfigToCell(c: VoucherRedeemerConfig): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4));
    for (const d of c.denominations) {
        dict.set(BigInt('0x' + voucherContentCell(d.content).hash().toString('hex')), d.amount);
    }
    return beginCell()
        .storeAddress(c.owner)
        .storeAddress(c.collection)
        .storeAddress(c.jettonWallet ?? null)
        .storeCoins(0)
        .storeUint(0, 64)
        .storeBit(c.paused ?? false)
        .storeRef(
            beginCell()
                .storeRef(c.nftItemCode)
                .storeDict(dict)
                .storeAddress(null) // pending_owner
                .storeUint(0, 32) // failed_payouts
                .endCell(),
        )
        .endCell();
}

export class VoucherRedeemer implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new VoucherRedeemer(address);
    }

    static createFromConfig(config: VoucherRedeemerConfig, code: Cell, workchain = 0) {
        const init = { code, data: voucherRedeemerConfigToCell(config) };
        return new VoucherRedeemer(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    private async op(provider: ContractProvider, via: Sender, value: bigint, build: (b: ReturnType<typeof beginCell>) => void, op: number) {
        const b = beginCell().storeUint(op, 32).storeUint(0, 64);
        build(b);
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: b.endCell() });
    }

    async sendSetJettonWallet(provider: ContractProvider, via: Sender, wallet: Address, value = toNano('0.02')) {
        await this.op(provider, via, value, (b) => b.storeAddress(wallet), RedeemerOpcodes.setJettonWallet);
    }

    /** amount = 0 removes the kind. */
    async sendSetDenomination(provider: ContractProvider, via: Sender, content: string, amount: bigint, value = toNano('0.02')) {
        const hash = BigInt('0x' + voucherContentCell(content).hash().toString('hex'));
        await this.op(provider, via, value, (b) => b.storeUint(hash, 256).storeCoins(amount), RedeemerOpcodes.setDenomination);
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, paused: boolean, value = toNano('0.02')) {
        await this.op(provider, via, value, (b) => b.storeBit(paused), RedeemerOpcodes.setPaused);
    }

    /** amount = 0 withdraws everything except 0.05 TON. */
    async sendWithdrawTon(provider: ContractProvider, via: Sender, amount = 0n, value = toNano('0.02')) {
        await this.op(provider, via, value, (b) => b.storeCoins(amount), RedeemerOpcodes.withdrawTon);
    }

    /**
     * `jettonWallet` is the redeemer's jetton wallet (GUM or any other token sent by mistake).
     * GUM: the tracked GUM go first, the rest (GUM sent without a notification) in a second transfer, so attach >= 0.1 TON.
     */
    async sendWithdrawJettons(provider: ContractProvider, via: Sender, jettonWallet: Address, amount: bigint, value = toNano('0.1')) {
        await this.op(provider, via, value, (b) => b.storeAddress(jettonWallet).storeCoins(amount), RedeemerOpcodes.withdrawJettons);
    }

    /** Send an NFT that sits on the redeemer to `to` (e.g. a voucher sent without forward_amount). */
    async sendRescueNft(provider: ContractProvider, via: Sender, nft: Address, to: Address, value = toNano('0.05')) {
        await this.op(provider, via, value, (b) => b.storeAddress(nft).storeAddress(to), RedeemerOpcodes.rescueNft);
    }

    /** Ownership change, step 1 (owner). `null` cancels a pending change. */
    async sendProposeOwner(provider: ContractProvider, via: Sender, newOwner: Address | null, value = toNano('0.02')) {
        await this.op(provider, via, value, (b) => b.storeAddress(newOwner), RedeemerOpcodes.proposeOwner);
    }

    /** Ownership change, step 2: sent by the proposed owner. */
    async sendAcceptOwner(provider: ContractProvider, via: Sender, value = toNano('0.02')) {
        await this.op(provider, via, value, () => {}, RedeemerOpcodes.acceptOwner);
    }

    async getRedeemerData(provider: ContractProvider) {
        const s = (await provider.get('get_redeemer_data', [])).stack;
        return {
            owner: s.readAddress(),
            collection: s.readAddress(),
            jettonWallet: s.readAddressOpt(),
            gumBalance: s.readBigNumber(),
            redeemedCount: s.readBigNumber(),
            paused: s.readBoolean(),
            pendingOwner: s.readAddressOpt(),
            failedPayouts: s.readNumber(), // payouts that bounced: the voucher was burned but the GUM did not arrive
        };
    }

    async getDenomination(provider: ContractProvider, content: string): Promise<bigint> {
        const hash = BigInt('0x' + voucherContentCell(content).hash().toString('hex'));
        return (await provider.get('get_denomination', [{ type: 'int', value: hash }])).stack.readBigNumber();
    }

    async getNftAddressByIndex(provider: ContractProvider, index: number | bigint): Promise<Address> {
        return (await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }])).stack.readAddress();
    }
}
