import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { fromGum, toGum } from './config';
import { pickRedeemer } from './redeemerAccess';

// Owner panel: status, withdraw TON / GUM, pause, change GUM amount of a kind, rescue NFT, change owner.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const { redeemer, data } = await pickRedeemer(provider, undefined, false);
    const ton = (await provider.provider(redeemer.address).getState()).balance;

    ui.write(`Owner:          ${data.owner.toString()}`);
    ui.write(`Collection:     ${data.collection.toString()}`);
    ui.write(`GUM wallet:     ${data.jettonWallet?.toString() ?? 'NOT SET'}`);
    ui.write(`GUM (tracked):  ${fromGum(data.gumBalance)}`);
    ui.write(`TON balance:    ${Number(ton) / 1e9}`);
    ui.write(`Redeemed:       ${data.redeemedCount}`);
    ui.write(`Paused:         ${data.paused}`);
    if (!data.owner.equals(provider.sender().address!)) {
        ui.write(`\n⚠ Your wallet ${provider.sender().address!.toString()} is not the owner: owner actions will fail.\n`);
    }

    const action = await ui.choose(
        'Action:',
        ['withdraw TON', 'withdraw GUM', data.paused ? 'unpause' : 'pause', 'set GUM for a kind', 'rescue NFT', 'change owner', 'exit'],
        (x) => x,
    );
    const s = provider.sender();
    switch (action) {
        case 'withdraw TON': {
            const a = await ui.input('Amount in TON (empty = everything except 0.05)');
            await redeemer.sendWithdrawTon(s, a.trim() ? toNano(a.trim()) : 0n);
            break;
        }
        case 'withdraw GUM': {
            const a = await ui.input(`Amount of GUM (tracked: ${fromGum(data.gumBalance)})`);
            await redeemer.sendWithdrawJettons(s, data.jettonWallet!, toGum(a.trim()));
            break;
        }
        case 'pause':
        case 'unpause':
            await redeemer.sendSetPaused(s, action === 'pause');
            break;
        case 'set GUM for a kind': {
            const content = await ui.input('Kind (item content suffix, e.g. 0.json)');
            const a = await ui.input('GUM per voucher (0 = disable this kind)');
            await redeemer.sendSetDenomination(s, content.trim(), toGum(a.trim()));
            break;
        }
        case 'rescue NFT': {
            const nft = await ui.inputAddress('NFT address');
            const to = await ui.inputAddress('Send it to');
            await redeemer.sendRescueNft(s, nft, to);
            break;
        }
        case 'change owner': {
            ui.write('⚠ The new owner gets full control: withdraw all TON and GUM, pause, change amounts.');
            ui.write('⚠ There is no confirmation from the new address — a wrong address means control is lost forever.');
            const newOwner = await ui.inputAddress('New owner address');
            const repeat = await ui.inputAddress('Repeat the new owner address');
            if (!newOwner.equals(repeat)) throw new Error('Addresses do not match, nothing sent.');
            if (newOwner.equals(data.owner)) throw new Error('This address is already the owner.');

            const forbidden: [Address | null, string][] = [
                [redeemer.address, 'the redeemer itself'],
                [data.jettonWallet, "the redeemer's GUM wallet"],
                [data.collection, 'the voucher collection'],
            ];
            for (const [a, what] of forbidden) {
                if (a && newOwner.equals(a)) throw new Error(`This is ${what}, not a wallet. Nothing sent.`);
            }

            const state = (await provider.provider(newOwner).getState()).state.type;
            if (state === 'active') {
                let isWallet = true;
                try {
                    await provider.provider(newOwner).get('seqno', []);
                } catch {
                    isWallet = false;
                }
                if (!isWallet && !(await ui.prompt('This address is a smart contract without `seqno` (not a regular wallet). Continue anyway?'))) {
                    ui.write('Cancelled.');
                    return;
                }
            } else {
                ui.write(`Note: ${newOwner.toString()} has never been used on ${provider.network()} (${state}). Make sure you have its seed phrase.`);
            }

            if (!(await ui.prompt(`Transfer ownership of ${redeemer.address.toString()} to ${newOwner.toString()}?`))) {
                ui.write('Cancelled.');
                return;
            }
            await redeemer.sendChangeOwner(s, newOwner);
            for (let i = 0; i < 20; i++) {
                await new Promise((r) => setTimeout(r, 3000));
                if ((await redeemer.getRedeemerData()).owner.equals(newOwner)) {
                    ui.write(`Owner changed to ${newOwner.toString()}.`);
                    return;
                }
            }
            ui.write('Not confirmed yet, check get_redeemer_data in an explorer.');
            return;
        }
    }
    ui.write('Done.');
}
