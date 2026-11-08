# Pinned NFT voucher code

Compiled code of [gumCommunity/nft-voucher](https://github.com/gumCommunity/nft-voucher) at commit `5409207`
(collection fixes of the 2026-11-08 security audit: strictly sequential item indexes, mint requests bounce when the
collection cannot pay). The item code is unchanged since `9baecad`.
The redeemer recognises vouchers by recomputing item addresses with **exactly this item code**,
so it must match the code the deployed collection uses (`deployRedeemer` checks it before deploying).

| Contract | Code hash |
|---|---|
| `NftVoucherItem` | `8544104bb7d757282fe1a2530f2f3cf11efd1a81e50c515aff3a9d19bf086901` |
| `NftVoucherCollection` | `811a47eca28786e7bf8a9b96e06c4bb8845f8bae7b774bd5a4bf9fea453517ba` |

The redeemer itself only depends on the **item** code; the collection code is used by tests. Collections deployed with
an older collection code (e.g. the first testnet deployment, `8e5aab17…7780`, or `62601efb…dc3a` before the audit) work
with the redeemer as long as their item code matches, but new collections should use the code above.

To update: run `npm run build` in nft-voucher and copy `build/NftVoucherItem.compiled.json`
and `build/NftVoucherCollection.compiled.json` here, then update the hashes above and in
`wrappers/nftVoucherCode.ts`.
