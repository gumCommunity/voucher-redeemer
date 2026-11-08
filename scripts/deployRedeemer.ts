import { toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { loadNftItemCode } from '../wrappers/nftVoucherCode';
import { VoucherRedeemer } from '../wrappers/VoucherRedeemer';
import { JettonMaster } from '../wrappers/Jetton';
import { VOUCHER_KINDS, gumMasterFor, toGum } from './config';
import { saveDeployment } from './redeemerAccess';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const owner = provider.sender().address!;

    const collection = await ui.inputAddress('Voucher collection address');
    const gumMaster = gumMasterFor(provider);
    ui.write(`Network: ${provider.network()}, GUM master: ${gumMaster.toString()}`);

    const redeemer = provider.open(
        VoucherRedeemer.createFromConfig(
            {
                owner,
                collection,
                nftItemCode: loadNftItemCode(), // pinned nft-voucher code; must be the code the collection uses
                denominations: VOUCHER_KINDS.map((k) => ({ content: k.content, amount: toGum(k.gum) })),
            },
            await compile('VoucherRedeemer'),
        ),
    );

    // sanity check: our item code really produces the collection's item addresses
    const fromCollection = await provider.provider(collection).get('get_nft_address_by_index', [{ type: 'int', value: 0n }]);
    const expected = fromCollection.stack.readAddress();

    await redeemer.sendDeploy(provider.sender(), toNano('0.1'));
    await provider.waitForDeploy(redeemer.address);

    const computed = await redeemer.getNftAddressByIndex(0);
    if (!computed.equals(expected)) {
        throw new Error('Item code mismatch: redeemer would not recognise vouchers of this collection!');
    }

    const gumWallet = await provider.open(JettonMaster.createFromAddress(gumMaster)).getWalletAddress(redeemer.address);
    await redeemer.sendSetJettonWallet(provider.sender(), gumWallet);

    saveDeployment(provider.network(), { redeemer: redeemer.address.toString(), collection: collection.toString() });
    ui.write(`Redeemer deployed:   ${redeemer.address.toString()}   (saved to deployments.json)`);
    ui.write(`Its GUM wallet:      ${gumWallet.toString()}   (do NOT send GUM here, send to the redeemer)`);
    ui.write('Next: npx blueprint run depositGum');
}
