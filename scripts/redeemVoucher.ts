import { toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';
import { REDEEM_FORWARD_AMOUNT } from '../wrappers/VoucherRedeemer';
import { pickRedeemer } from './redeemerAccess';

// What a user does: send the voucher NFT to the redeemer with forward_amount.
// The same can be done from any wallet that allows setting forward amount (or from your dApp).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const nft = provider.open(NftVoucherItem.createFromAddress(await ui.inputAddress('Voucher (NFT) address')));
    const { address: redeemer } = await pickRedeemer(provider);

    await nft.sendTransfer(provider.sender(), {
        newOwner: redeemer,
        responseDestination: provider.sender().address!,
        forwardAmount: REDEEM_FORWARD_AMOUNT,
        value: REDEEM_FORWARD_AMOUNT + toNano('0.05'),
    });

    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await nft.getIsBurned()) {
            ui.write('Voucher redeemed: GUM are on the way to your wallet.');
            return;
        }
        const { ownerAddress } = await nft.getNftData();
        if (ownerAddress?.equals(provider.sender().address!) && i > 3) {
            ui.write('Voucher was returned (redeemer paused, out of GUM, or unknown kind).');
            return;
        }
    }
    ui.write('Not confirmed yet, check the transaction in an explorer.');
}
