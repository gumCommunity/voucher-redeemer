// Remembers deployed addresses per network and makes sure scripts talk to a real redeemer.
import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { VoucherRedeemer } from '../wrappers/VoucherRedeemer';
import { JettonMaster } from '../wrappers/Jetton';
import { gumMasterFor } from './config';

const FILE = join(__dirname, '..', 'deployments.json');

type Deployment = { redeemer?: string; collection?: string };

export function loadDeployments(): Record<string, Deployment> {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
}

export function saveDeployment(network: string, d: Deployment) {
    const all = loadDeployments();
    all[network] = { ...all[network], ...d };
    writeFileSync(FILE, JSON.stringify(all, null, 4) + '\n');
}

/**
 * Asks for the redeemer address (Enter = the one saved by deployRedeemer) and verifies it:
 * the contract must answer get_redeemer_data and, if `requireGumWallet`, hold the GUM wallet of this network.
 */
export async function pickRedeemer(provider: NetworkProvider, arg?: string, requireGumWallet = true) {
    const ui = provider.ui();
    const saved = loadDeployments()[provider.network()]?.redeemer;
    const address = arg
        ? Address.parse(arg)
        : await ui.inputAddress(saved ? `Redeemer address (Enter = ${saved})` : 'Redeemer address', saved ? Address.parse(saved) : undefined);

    const redeemer = provider.open(VoucherRedeemer.createFromAddress(address));
    let data;
    try {
        data = await redeemer.getRedeemerData();
    } catch {
        throw new Error(
            `${address.toString()} is not a voucher redeemer (get_redeemer_data failed).\n` +
                'Use the address printed as "Redeemer deployed:", not its GUM wallet or the GUM master.',
        );
    }

    if (requireGumWallet) {
        const expected = await provider.open(JettonMaster.createFromAddress(gumMasterFor(provider))).getWalletAddress(address);
        if (!data.jettonWallet || !data.jettonWallet.equals(expected)) {
            throw new Error(`Redeemer ${address.toString()} is not linked to the GUM wallet of ${provider.network()} (expected ${expected.toString()}).`);
        }
    }
    ui.write(`Redeemer: ${address.toString()}`);
    return { redeemer, data, address };
}
