# Redeem page (TON Connect)

Static page, no backend. A user connects a wallet, sees their Gumcoin vouchers and presses **Redeem**.
The wallet signs an NFT transfer to the redeemer with `forward_amount` 0.15 TON (0.2 TON attached in total, the unused part
is returned). The page then follows the NFT and shows the result: GUM sent, voucher returned (paused / not enough GUM),
or voucher stuck (contact support).

Live: https://gumcommunity.github.io/voucher-redeemer/

## Configuration

Settings are build-time variables in `web/.env.local` (copy `.env.example`):

| Variable | Value |
|---|---|
| `VITE_NETWORK` | `testnet` or `mainnet` |
| `VITE_REDEEMER_ADDRESS` | redeemer address (printed by `deployRedeemer`) |
| `VITE_COLLECTION_ADDRESS` | voucher collection address |
| `VITE_TONAPI_KEY` | optional tonapi.io client key; without it tonapi allows ~1 request/s and the page waits and retries |

Until the addresses are set the page shows "not configured".

`public/tonconnect-manifest.json` must point to the site where the page is hosted (`url`) and to a square PNG icon (`iconUrl`).

## Deploy to GitHub Pages (no Actions)

One time, in the repository: Settings → Pages → Build and deployment → Source: **Deploy from a branch** →
branch **`gh-pages`**, folder **`/ (root)`** → Save.

Then, every time you want to update the page (after changing `.env.local` or the code):

```bash
cd web
npm run deploy    # checks .env.local, builds, pushes dist/ to the gh-pages branch
```

The page is served at https://gumcommunity.github.io/voucher-redeemer/ a minute or two later.
Switching to mainnet = change `.env.local` and run `npm run deploy` again.

## Build and run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static files in dist/
npm run deploy    # publish dist/ to GitHub Pages (gh-pages branch)
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
