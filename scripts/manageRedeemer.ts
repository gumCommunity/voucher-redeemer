import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { fromGum, toGum } from './config';
import { pickRedeemer } from './redeemerAccess';

// Owner panel: status, withdraw TON / GUM, pause, change GUM amount of a kind, rescue NFT.
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

    const action = await ui.choose(
        'Action:',
        ['withdraw TON', 'withdraw GUM', data.paused ? 'unpause' : 'pause', 'set GUM for a kind', 'rescue NFT', 'exit'],
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
    }
    ui.write('Done.');
}
