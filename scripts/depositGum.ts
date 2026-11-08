import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { JettonMaster, JettonWallet } from '../wrappers/Jetton';
import { VoucherRedeemer } from '../wrappers/VoucherRedeemer';
import { fromGum, gumMasterFor, toGum } from './config';

// Sends GUM from your wallet to the redeemer WITH a notification (forward_ton_amount),
// otherwise the redeemer does not count the deposit.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const redeemerAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Redeemer address');
    const gumMaster = gumMasterFor(provider);
    const amount = toGum(await ui.input('How many GUM to deposit'));

    const myWallet = provider.open(
        JettonWallet.createFromAddress(await provider.open(JettonMaster.createFromAddress(gumMaster)).getWalletAddress(provider.sender().address!)),
    );
    await myWallet.sendTransfer(provider.sender(), { to: redeemerAddress, amount, forwardTonAmount: toNano('0.01'), value: toNano('0.1') });

    const redeemer = provider.open(VoucherRedeemer.createFromAddress(redeemerAddress));
    const before = (await redeemer.getRedeemerData()).gumBalance;
    ui.write('Waiting for the deposit to be counted...');
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const now = (await redeemer.getRedeemerData()).gumBalance;
        if (now > before) {
            ui.write(`Redeemer GUM balance: ${fromGum(now)} GUM`);
            return;
        }
    }
    ui.write('Not confirmed yet, check the redeemer in an explorer.');
}
