# Pinned NFT voucher code

Compiled code of [gumCommunity/nft-voucher](https://github.com/gumCommunity/nft-voucher) at commit `9baecad`.
The redeemer recognises vouchers by recomputing item addresses with **exactly this item code**,
so it must match the code the deployed collection uses (`deployRedeemer` checks it on-chain).

| Contract | Code hash |
|---|---|
| `NftVoucherItem` | `8544104bb7d757282fe1a2530f2f3cf11efd1a81e50c515aff3a9d19bf086901` |
| `NftVoucherCollection` | `8e5aab17e2e503bec75c2f453b9dacf11a98bbb2cc202994710952a7271c7780` |

To update: run `npm run build` in nft-voucher and copy `build/NftVoucherItem.compiled.json`
and `build/NftVoucherCollection.compiled.json` here, then update the hashes above and in
`wrappers/nftVoucherCode.ts`.
