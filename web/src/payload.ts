// Pure transaction builder (no browser APIs) — also covered by tests/WebPayload.spec.ts in the redeemer project.
import { Address, beginCell, Cell } from '@ton/core';

export const NFT_TRANSFER_OP = 0x5fcc3d14;
/** TON that reaches the redeemer with ownership_assigned: pays only the notification and the data request
 *  (~0.002 TON). Burn and GUM transfer are paid by the redeemer after it has verified the voucher. */
export const REDEEM_FORWARD_AMOUNT = 15_000_000n; // 0.015 TON
/** Total attached to the NFT transfer. Nothing comes back to the user: what is left stays on the NFT and goes to the
 *  redeemer with the NFT balance on burn (or back to the user inside the voucher if the redeemer returns it). */
export const REDEEM_TX_AMOUNT = 30_000_000n; // 0.03 TON (forward + ~0.011 NFT gas)
/** Below this TON balance the redeemer returns vouchers instead of paying (contract: min_storage + destroy + payout + fees). */
export const REDEEMER_MIN_TON = 180_000_000n; // 0.18 TON

/** TEP-62 NFT transfer: voucher -> redeemer, no excess (response_destination = addr_none), with forward_amount for the notification. */
export function buildRedeemPayload(redeemer: string, queryId: bigint = 0n): Cell {
    return beginCell()
        .storeUint(NFT_TRANSFER_OP, 32)
        .storeUint(queryId, 64)
        .storeAddress(Address.parse(redeemer)) // new_owner
        .storeAddress(null) // response_destination = addr_none: no excess back to the user
        .storeBit(false) // no custom_payload
        .storeCoins(REDEEM_FORWARD_AMOUNT)
        .storeBit(false) // empty forward_payload
        .endCell();
}

/** TON Connect message (amount as string, payload as base64 BOC). */
export function buildRedeemMessage(nft: string, redeemer: string, queryId: bigint = 0n) {
    return {
        address: Address.parse(nft).toString({ bounceable: true }),
        amount: REDEEM_TX_AMOUNT.toString(),
        payload: buildRedeemPayload(redeemer, queryId).toBoc().toString('base64'),
    };
}

/** Same content cell the collection stores for an item ("0.json" etc.), used to look up its GUM amount. */
export function contentHash(suffix: string): bigint {
    return BigInt('0x' + beginCell().storeStringTail(suffix).endCell().hash().toString('hex'));
}
