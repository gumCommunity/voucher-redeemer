// Sandbox helpers that run the REAL GUM jetton wallet code (library cell, same on mainnet and testnet).
import { Blockchain, createShardAccount } from '@ton/sandbox';
import { Address, beginCell, contractAddress, Dictionary, toNano } from '@ton/core';
import { GUM_WALLET_CODE, GUM_WALLET_LIBRARY } from '../fixtures/gumWallet';

export const GUM_MASTER = Address.parse('0:81fa8e5475134728231b174561afc2b09859b98c89db8db915daebe21eccdb41'); // testnet GUM
export const OTHER_MASTER = Address.parse('0:' + '11'.repeat(32)); // some other jetton with the same wallet code

export const GUM = (n: number | bigint) => BigInt(n) * 1_000_000_000n; // 9 decimals

export function installGumLibrary(blockchain: Blockchain) {
    const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    libs.set(BigInt('0x' + GUM_WALLET_LIBRARY.hash().toString('hex')), GUM_WALLET_LIBRARY);
    blockchain.libs = beginCell().storeDictDirect(libs).endCell();
}

// Jetton 2.0 wallet storage: status:uint4 balance:Coins owner:MsgAddress master:MsgAddress
function walletInit(owner: Address, master: Address, balance: bigint) {
    return {
        code: GUM_WALLET_CODE,
        data: beginCell().storeUint(0, 4).storeCoins(balance).storeAddress(owner).storeAddress(master).endCell(),
    };
}

/** Same address the jetton master returns from get_wallet_address. */
export const jettonWalletAddress = (owner: Address, master: Address = GUM_MASTER) => contractAddress(0, walletInit(owner, master, 0n));

/** Creates a wallet that already holds `amount` (as if it had been minted). Use for accounts without a wallet yet. */
export async function giveJettons(blockchain: Blockchain, owner: Address, amount: bigint, master: Address = GUM_MASTER) {
    const address = jettonWalletAddress(owner, master);
    const init = walletInit(owner, master, amount);
    await blockchain.setShardAccount(address, createShardAccount({ address, code: init.code, data: init.data, balance: toNano('0.1') }));
    return address;
}
