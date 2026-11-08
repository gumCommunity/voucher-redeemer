import { toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { JettonMaster, JettonWallet } from '../wrappers/Jetton';
import { fromGum, gumMasterFor, toGum } from './config';
import { pickRedeemer } from './redeemerAccess';

// Sends GUM from your wallet to the redeemer WITH a notification (forward_ton_amount),
// otherwise the redeemer does not count the deposit.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const { redeemer, address: redeemerAddress, data } = await pickRedeemer(provider, args[0]);

    const myWallet = provider.open(
        JettonWallet.createFromAddress(await provider.open(JettonMaster.createFromAddress(gumMasterFor(provider))).getWalletAddress(provider.sender().address!)),
    );
    const myBalance = await myWallet.getBalance();
    ui.write(`Your GUM:      ${fromGum(myBalance)}`);
    ui.write(`Redeemer GUM:  ${fromGum(data.gumBalance)}`);

    let amount = 0n;
    while (amount <= 0n || amount > myBalance) {
        const input = (await ui.input('How many GUM to deposit (whole GUM, e.g. 100000)')).trim().replace(/[\s_]/g, '');
        try {
            amount = /^\d+(\.\d+)?$/.test(input) ? toGum(input) : 0n;
        } catch {
            amount = 0n;
        }
        if (amount <= 0n) ui.write('Enter a positive number.');
        else if (amount > myBalance) ui.write(`You only have ${fromGum(myBalance)} GUM.`);
    }

    if (!(await ui.prompt(`Send ${fromGum(amount)} GUM to the redeemer ${redeemerAddress.toString()}?`))) {
        ui.write('Cancelled.');
        return;
    }

    const before = data.gumBalance;
    await myWallet.sendTransfer(provider.sender(), { to: redeemerAddress, amount, forwardTonAmount: toNano('0.01'), value: toNano('0.1') });

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
