# Redeem page (TON Connect)

Static page, no backend. A user connects a wallet, sees their Gumcoin vouchers and presses **Redeem**.
The wallet signs an NFT transfer to the redeemer with `forward_amount` 0.15 TON (0.2 TON attached in total, the unused part
is returned). The page then follows the NFT and shows the result: GUM sent, voucher returned (paused / not enough GUM),
or voucher stuck (contact support).

Live: https://gumcommunity.github.io/voucher-redeemer/

## Configuration

Settings are build-time variables:

| Variable | Value |
|---|---|
| `VITE_NETWORK` | `testnet` or `mainnet` |
| `VITE_REDEEMER_ADDRESS` | redeemer address (printed by `deployRedeemer`) |
| `VITE_COLLECTION_ADDRESS` | voucher collection address |
| `VITE_TONAPI_KEY` | optional tonapi.io client key; without it tonapi allows ~1 request/s and the page waits and retries |

**GitHub Pages:** Settings → Secrets and variables → Actions → **Variables** → add the variables above, then
Actions → *Deploy redeem page* → **Run workflow**. Until the addresses are set the page shows "not configured".

**Locally:** copy `.env.example` to `.env.local` and fill it in.

`public/tonconnect-manifest.json` must point to the site where the page is hosted (`url`) and to a square PNG icon (`iconUrl`).

## Build and run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static files in dist/
```

A mobile wallet downloads the manifest from a public HTTPS URL, so connecting from a phone to `localhost` does not work:
test on the deployed page or through a tunnel.

## Checks before sending

- the wallet is on the same network as the contracts;
- voucher kind: the NFT content is read from the blockchain, the GUM amount comes from the redeemer (`get_denomination`);
- the redeemer is not paused and has enough GUM;
- the user has ~0.22 TON for fees.

The transaction built by `src/payload.ts` is covered by `../tests/VoucherRedeemer.spec.ts`: the test sends exactly what the
wallet receives (address, amount, base64 payload) and checks that the voucher is burned and GUM arrive.

All UI texts are in the `T` object at the top of `src/main.ts`.
