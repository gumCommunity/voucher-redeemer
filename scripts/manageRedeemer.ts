import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { fromGum, toGum } from './config';
import { pickRedeemer } from './redeemerAccess';

// Owner panel: status, withdraw TON / GUM, pause, change GUM amount of a kind, rescue NFT, change owner (two steps).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const { redeemer, data } = await pickRedeemer(provider, undefined, false);
    const ton = (await provider.provider(redeemer.address).getState()).balance;
    const me = provider.sender().address!;

    ui.write(`Owner:          ${data.owner.toString()}${data.pendingOwner ? `  (pending: ${data.pendingOwner.toString()})` : ''}`);
    ui.write(`Collection:     ${data.collection.toString()}`);
    ui.write(`GUM wallet:     ${data.jettonWallet?.toString() ?? 'NOT SET'}`);
    ui.write(`GUM (tracked):  ${fromGum(data.gumBalance)}`);
    ui.write(`TON balance:    ${Number(ton) / 1e9}`);
    ui.write(`Redeemed:       ${data.redeemedCount}`);
    ui.write(`Paused:         ${data.paused}`);
    if (data.failedPayouts > 0) {
        ui.write(`\n⚠ Failed payouts: ${data.failedPayouts}. These vouchers were burned but their GUM transfer bounced.`);
        ui.write('  Find the bounced transfers from the GUM wallet in an explorer: query_id = voucher index; pay those users manually.\n');
    }

    if (data.pendingOwner?.equals(me)) {
        if (await ui.prompt('You are the proposed owner. Accept the ownership now?')) {
            await redeemer.sendAcceptOwner(provider.sender());
            await waitFor(async () => (await redeemer.getRedeemerData()).owner.equals(me), ui, 'You are now the owner.');
        }
        return;
    }
    if (!data.owner.equals(me)) {
        ui.write(`\n⚠ Your wallet ${me.toString()} is not the owner: owner actions will fail.\n`);
    }

    const action = await ui.choose(
        'Action:',
        [
            'withdraw TON',
            'withdraw GUM',
            data.paused ? 'unpause' : 'pause',
            'set GUM for a kind',
            'rescue NFT',
            data.pendingOwner ? 'cancel owner change' : 'propose new owner',
            'exit',
        ],
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
            const a = await ui.input(`Amount of GUM (tracked: ${fromGum(data.gumBalance)}; more takes GUM sent without a notification too)`);
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
        case 'cancel owner change':
            await redeemer.sendProposeOwner(s, null);
            await waitFor(async () => (await redeemer.getRedeemerData()).pendingOwner === null, ui, 'Owner change cancelled.');
            return;
        case 'propose new owner': {
            ui.write('⚠ The new owner gets full control: withdraw all TON and GUM, pause, change amounts.');
            ui.write('The new owner must then run manageRedeemer from their wallet and accept. Until then you stay the owner.');
            const newOwner = await ui.inputAddress('New owner address');
            const repeat = await ui.inputAddress('Repeat the new owner address');
            if (!newOwner.equals(repeat)) throw new Error('Addresses do not match, nothing sent.');
            if (newOwner.equals(data.owner)) throw new Error('This address is already the owner.');
            if (newOwner.workChain !== 0) throw new Error('The owner must be a basechain (workchain 0) address.');

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

            if (!(await ui.prompt(`Propose ${newOwner.toString()} as the owner of ${redeemer.address.toString()}?`))) {
                ui.write('Cancelled.');
                return;
            }
            await redeemer.sendProposeOwner(s, newOwner);
            await waitFor(async () => !!(await redeemer.getRedeemerData()).pendingOwner?.equals(newOwner), ui, 'Proposed. Waiting for the new owner to accept.');
            return;
        }
    }
    ui.write('Done.');
}

async function waitFor(check: () => Promise<boolean>, ui: ReturnType<NetworkProvider['ui']>, done: string) {
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            if (await check()) {
                ui.write(done);
                return;
            }
        } catch {
            /* indexer lag, retry */
        }
    }
    ui.write('Not confirmed yet, check get_redeemer_data in an explorer.');
}
