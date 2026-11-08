# Pinned NFT voucher code

Compiled code of [gumCommunity/nft-voucher](https://github.com/gumCommunity/nft-voucher) at commit `e372988` (item code unchanged since `9baecad`).
The redeemer recognises vouchers by recomputing item addresses with **exactly this item code**,
so it must match the code the deployed collection uses (`deployRedeemer` checks it on-chain).

| Contract | Code hash |
|---|---|
| `NftVoucherItem` | `8544104bb7d757282fe1a2530f2f3cf11efd1a81e50c515aff3a9d19bf086901` |
| `NftVoucherCollection` | `62601efb91d228522520abb94aaeeafc058c6ae1423c8e0b8085fddc4501dc3a` |

The redeemer itself only depends on the **item** code; the collection code is used by tests. Collections deployed with
an older collection code (e.g. the first testnet deployment, `8e5aab17…7780`, without changeable royalty) work with the
redeemer as long as their item code matches.

To update: run `npm run build` in nft-voucher and copy `build/NftVoucherItem.compiled.json`
and `build/NftVoucherCollection.compiled.json` here, then update the hashes above and in
`wrappers/nftVoucherCode.ts`.
