# Gumcoin Voucher Redeemer

TON smart contract (FunC) that exchanges [Gumcoin NFT vouchers](https://github.com/gumCommunity/nft-voucher) for GUM,
plus a web page where users connect their wallet (TON Connect) and redeem vouchers.

**Redeem page:** https://gumcommunity.github.io/voucher-redeemer/

- A user sends a voucher NFT to the redeemer and receives **10 000 / 5 000 / 1 000 GUM** depending on the voucher kind.
- The NFT is burned; the TON stored in the NFT goes to the redeemer.
- The owner can withdraw TON and GUM at any time.

## How a redemption works

```
user ── transfer(new_owner = redeemer, forward_amount = 0.15 TON) ──> NFT
NFT ── ownership_assigned(prev_owner) ──> redeemer
redeemer ── request_voucher_data ──> NFT
NFT ── report_voucher_data(index, owner, content) ──> redeemer
        checks: sender == address of item #index of OUR collection (fakes are rejected)
                NFT owner == redeemer;  hash(content) -> GUM amount
  ├─ OK:    redeemer ── GUM ──> user (comment "Gumcoin voucher redeemed")
  │         redeemer ── destroy ──> NFT ── whole TON balance ──> redeemer
  └─ else:  redeemer ── NFT back ──> user
            (paused / not enough GUM / unknown kind / too little TON attached)
```

**`forward_amount` ≥ 0.15 TON is required.** Without it the NFT does not notify the redeemer and the voucher stays on the
redeemer; the owner can send it back with `rescue_nft`. Regular wallets do not attach `forward_amount` when sending an NFT,
so users should redeem through the [redeem page](web/), which builds the right transaction.

## GUM

| Network | Jetton master | Decimals |
|---|---|---|
| mainnet | `EQC8prgBYisGDdRZ2ZmmJHom1-a6WZDT5atEBn1ZvTA--GUM` | 9 |
| testnet | `0:81fa8e5475134728231b174561afc2b09859b98c89db8db915daebe21eccdb41` | 9 |

Scripts pick the master by `--mainnet` / `--testnet` (`scripts/config.ts`).
GUM wallets on both networks use the same Jetton 2.0 library cell (`ba2918c8…5395`); **all tests run against this real
wallet code** (`tests/fixtures/gumWallet.ts`, `tests/helpers/gum.ts`).

### GUM accounting

The redeemer counts only GUM that arrive **with a notification** (`transfer_notification`, i.e. `forward_ton_amount > 0`);
`depositGum` sends it this way.
- A voucher is redeemed only if the counted GUM are enough; otherwise the NFT is returned and the user loses nothing.
- GUM sent without a notification are not counted, but the owner can still withdraw them.
- If a GUM transfer from the redeemer bounces, the counted balance is restored.
- Other jettons are not counted; the owner can withdraw them with `withdraw_jettons` (passing the redeemer's wallet of that jetton).

## Owner operations

| Operation | Op | Description |
|---|---|---|
| `set_jetton_wallet` | `0x18cb206a` | once: the redeemer's GUM wallet (done by `deployRedeemer`) |
| `set_denomination` | `0x421c9bac` | GUM amount for a voucher kind (`0` disables the kind) |
| `set_paused` | `0x00dc73fc` | pause: received vouchers are sent back |
| `withdraw_ton` | `0x30ee853f` | withdraw TON (`0` = everything except 0.05 TON) |
| `withdraw_jettons` | `0x7bd18a75` | withdraw GUM or any other jetton |
| `rescue_nft` | `0x239c982e` | send an NFT held by the redeemer to any address |
| `change_owner` | `0x690b6f7c` | change the owner |

Get methods: `get_redeemer_data`, `get_denomination(content_hash)`, `get_nft_address_by_index(index)`.

Errors: `401` not the owner, `403` NFT is not from our collection, `404` NFT is not owned by the redeemer,
`405` jetton wallet already set, `406` not enough TON.

## Repository layout

| Path | |
|---|---|
| `contracts/voucher_redeemer.fc` | the redeemer |
| `contracts/nft-voucher/` | pinned compiled code of nft-voucher (item + collection), see its README |
| `wrappers/` | TypeScript wrappers (redeemer, NFT copies from nft-voucher, generic jetton) |
| `tests/` | sandbox tests with the real GUM wallet code |
| `scripts/` | deploy / deposit / redeem / manage |
| `web/` | redeem page (TON Connect), published to GitHub Pages from the `gh-pages` branch |

## Usage

```bash
npm install
(cd web && npm install)   # tests also check the page's transaction builder
npm run build
npm test

# voucher amounts per kind: scripts/config.ts
npx blueprint run deployRedeemer --testnet     # asks for the collection address
npx blueprint run depositGum --testnet         # from the wallet that holds GUM
npx blueprint run redeemVoucher --testnet      # redeem as a user
npx blueprint run manageRedeemer --testnet     # status, withdraw TON/GUM, pause, amounts, rescue
```

**Deployment order:** first the collection from [nft-voucher](https://github.com/gumCommunity/nft-voucher), then the redeemer.
`deployRedeemer` checks on-chain that the pinned item code matches the collection.

After deploying, put the addresses into `web/.env.local` and run `cd web && npm run deploy` (see [web/README.md](web/README.md)).

## Notes

- The redeemer attaches 0.05 TON to each GUM transfer; with the real GUM wallet the transfer costs ~0.003 TON, the rest is returned to the receiver.
- The collection owner can mint vouchers and therefore effectively controls the GUM on the redeemer. Keep the collection owner and redeemer owner keys safe.
- Test on testnet first and get an audit before mainnet.

## License

MIT, see [LICENSE](LICENSE).
