// Generic TEP-74 jetton wrappers (work with GUM and any standard jetton).
import { Address, beginCell, Contract, ContractProvider, Sender, SendMode, toNano } from '@ton/core';

export class JettonMaster implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new JettonMaster(address);
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const res = await provider.get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
        return res.stack.readAddress();
    }
}

export class JettonWallet implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new JettonWallet(address);
    }

    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        opts: { to: Address; amount: bigint; responseDestination?: Address; forwardTonAmount?: bigint; value?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value ?? toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x0f8a7ea5, 32)
                .storeUint(0, 64)
                .storeCoins(opts.amount)
                .storeAddress(opts.to)
                .storeAddress(opts.responseDestination ?? via.address!)
                .storeBit(false)
                .storeCoins(opts.forwardTonAmount ?? 0n)
                .storeBit(false)
                .endCell(),
        });
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState();
        if (state.state.type !== 'active') return 0n;
        return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
    }
}
