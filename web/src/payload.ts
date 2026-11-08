// Pure transaction builder (no browser APIs) — also covered by tests/WebPayload.spec.ts in the redeemer project.
import { Address, beginCell, Cell } from '@ton/core';

export const NFT_TRANSFER_OP = 0x5fcc3d14;
/** TON that reaches the redeemer with ownership_assigned (pays for GUM transfer + burn). */
export const REDEEM_FORWARD_AMOUNT = 150_000_000n; // 0.15 TON
/** Total attached to the NFT transfer; NFT gas + fees ~0.01, the rest returns to the user as excess. */
export const REDEEM_TX_AMOUNT = 200_000_000n; // 0.2 TON

/** TEP-62 NFT transfer: voucher -> redeemer, excess -> user, with forward_amount for the notification. */
export function buildRedeemPayload(redeemer: string, user: string, queryId: bigint = 0n): Cell {
    return beginCell()
        .storeUint(NFT_TRANSFER_OP, 32)
        .storeUint(queryId, 64)
        .storeAddress(Address.parse(redeemer)) // new_owner
        .storeAddress(Address.parse(user)) // response_destination
        .storeBit(false) // no custom_payload
        .storeCoins(REDEEM_FORWARD_AMOUNT)
        .storeBit(false) // empty forward_payload
        .endCell();
}

/** TON Connect message (amount as string, payload as base64 BOC). */
export function buildRedeemMessage(nft: string, redeemer: string, user: string, queryId: bigint = 0n) {
    return {
        address: Address.parse(nft).toString({ bounceable: true }),
        amount: REDEEM_TX_AMOUNT.toString(),
        payload: buildRedeemPayload(redeemer, user, queryId).toBoc().toString('base64'),
    };
}

/** Same content cell the collection stores for an item ("0.json" etc.), used to look up its GUM amount. */
export function contentHash(suffix: string): bigint {
    return BigInt('0x' + beginCell().storeStringTail(suffix).endCell().hash().toString('hex'));
}
