# Gumcoin Voucher Redeemer

TON smart contract (FunC) that exchanges [Gumcoin NFT vouchers](https://github.com/gumCommunity/nft-voucher) for GUM,
plus a web page where users connect their wallet (TON Connect) and redeem vouchers.

**Redeem page:** https://gumcommunity.github.io/voucher-redeemer/

- A user sends a voucher NFT to the redeemer and receives **10 000 / 5 000 / 1 000 GUM** depending on the voucher kind.
- The NFT is burned; the TON stored in the NFT goes to the redeemer. The user gets **only GUM** and pays only
  **0.03 TON** (attached on the redeem page, not returned). The burn and the GUM transfer are paid by the redeemer from
  its own balance, after it has verified the voucher; the voucher's TON refunds it (~+0.26 TON per redemption for a
  voucher holding 0.24 TON).
- The owner can withdraw TON and GUM at any time. While redemptions are active, 0.5 TON stays on the redeemer as the
  operating reserve (see [TON](#ton)).

## How a redemption works

```
user ── transfer(new_owner = redeemer, response_destination = none, forward_amount = 0.015 TON) ──> NFT   (0.03 TON attached)
        (no excess to the user: what is left of the attached TON stays on the NFT)
NFT ── ownership_assigned(prev_owner) ──> redeemer                  ┐ paid by the user's forward_amount:
redeemer ── request_voucher_data ──> NFT                            ┘ the sender is not verified yet
NFT ── report_voucher_data(index, owner, content) ──> redeemer
        checks: sender == address of item #index of OUR collection (fakes are rejected)
                NFT owner == redeemer;  hash(content) -> GUM amount
        from here on the redeemer pays from its own balance
  ├─ OK:    redeemer ── destroy (0.02 TON) ──> NFT ── whole TON balance ──> redeemer
  │         redeemer ── GUM (0.1 TON attached) ──> user (comment "Gumcoin voucher redeemed");
  │                     the unused TON comes back to the redeemer as the jetton excess
  ├─ else:  redeemer ── NFT back (0.05 TON attached, excess back to the redeemer) ──> user
  │         (paused / not enough GUM / unknown kind / not enough TON on the redeemer)
  └─ prev_owner is not a basechain wallet (masterchain owner, or the collection when a voucher is minted
            straight to the redeemer): nothing is sent, the voucher stays on the redeemer for `rescue_nft`
```

**A voucher is never burned without its GUM transfer.** The burn and the GUM transfer are sent in one action phase
(both or none), and the redeemer checks before that it has the TON for both. Burn and payout use fixed amounts with a
large margin (the GUM transfer uses ~0.003 of its 0.1 TON), so fee changes do not matter there. (A GUM transfer can
still bounce if the GUM wallet holds less than the counted balance; that case is counted in `failed_payouts`, see
[GUM accounting](#gum-accounting).)

**`forward_amount` pays only the first two steps** (~0.002 TON). Without it the NFT does not notify the redeemer and
the voucher stays on the redeemer; the owner can send it back with `rescue_nft`. Measured in the sandbox with the real
GUM wallet (`forward_amount` → result):

| network fees | 0.001 | 0.002–0.005 | 0.008 | **0.015 (page)** | 0.03 |
|---|---|---|---|---|---|
| as now | waits for rescue | redeemed | redeemed | **redeemed** | redeemed |
| ×3 | waits | waits | redeemed | **redeemed** | redeemed |
| ×10 | waits | waits | waits | waits | redeemed |

"Waits" is safe: the voucher is on the redeemer, not burned, and the owner returns it with `rescue_nft` (raise
`REDEEM_FORWARD_AMOUNT` on the page if fees ever grow that much). Regular wallets do not attach `forward_amount` when
sending an NFT, so users should redeem through the [redeem page](web/), which builds the right transaction.

### TON

The redeemer pays the burn and the GUM transfer (~0.13 TON in flight, ~0.006 actually spent) before the voucher's TON
comes back with the burn, so it needs a balance:
- `deployRedeemer` deploys it with **0.6 TON** (0.5 operating reserve + storage);
- while it is **not paused**, `withdraw_ton` always leaves **0.5 TON**, and `set_paused(false)` is refused without it;
- when **paused**, everything except 0.05 TON can be withdrawn (e.g. when moving to a new redeemer);
- if the balance still drops below ~0.18 TON, vouchers are sent back instead of being redeemed, and the redeem page
  shows "temporarily unavailable".

Spam does not cost the redeemer anything: a fake `ownership_assigned` gets only its own TON back (the request is paid with
mode 64 from the notification), a forged report is rejected, and a voucher sent back (paused, unknown kind) returns its
excess to the redeemer, so sending it around in a loop costs the sender ~0.03 TON per round. `tests/Attacks.spec.ts`
runs every attack we could think of (fake notifications and reports, replays, forged deposits and bounces, double
redemption, two reports before a burn refund, huge payloads, empty vouchers from a leaked minting key, foreign
collections, owner operations from a stranger) and checks after each one that the counted GUM match the wallet, the
attacker gets nothing, no payout failed and the redeemer's TON did not go down.

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
- GUM sent without a notification are not counted, but the owner can still withdraw them: `withdraw_jettons` takes the
  counted GUM first and the rest in a second transfer (attach 0.1 TON).
- If a GUM transfer from the redeemer bounces, the counted balance is restored (the amount is read from the bounced
  message, so there is no limit on amounts).
- A bounced **voucher payout** cannot be undone: the voucher is already burned. It is counted in `failed_payouts`
  (`get_redeemer_data`, shown by `manageRedeemer`) and its `query_id` is the voucher index, so the user can be found and
  paid manually. With the real GUM wallet this does not happen in normal operation: in the sandbox no payout bounced even
  with network fees ×120 (the voucher is sent back or waits for `rescue_nft` instead); it would take GUM missing from the
  redeemer's wallet or a broken wallet.
- Other jettons are not counted; the owner can withdraw them with `withdraw_jettons` (passing the redeemer's wallet of that jetton).

## Owner operations

| Operation | Op | Description |
|---|---|---|
| `set_jetton_wallet` | `0x18cb206a` | once: the redeemer's GUM wallet, a basechain address (done by `deployRedeemer`) |
| `set_denomination` | `0x421c9bac` | GUM amount for a voucher kind (`0` disables the kind) |
| `set_paused` | `0x00dc73fc` | pause: received vouchers are sent back; unpausing requires 0.5 TON on the redeemer |
| `withdraw_ton` | `0x30ee853f` | withdraw TON (`0` = everything except the reserve: 0.5 TON while active, 0.05 TON when paused) |
| `withdraw_jettons` | `0x7bd18a75` | withdraw GUM (counted first, then uncounted) or any other jetton |
| `rescue_nft` | `0x239c982e` | send an NFT held by the redeemer to any address |
| `propose_owner` | `0x027ced09` | step 1 of an owner change: a basechain address, `addr_none` cancels |
| `accept_owner` | `0x7d5cdfed` | step 2: sent by the proposed owner; until then the old owner keeps full control |

`manageRedeemer` does both steps: the owner chooses *propose new owner*, the new owner runs the script from their wallet
and accepts.

Get methods: `get_redeemer_data` (owner, collection, GUM wallet, counted GUM, redeemed count, paused, pending owner,
failed payouts), `get_denomination(content_hash)`, `get_nft_address_by_index(index)`.

Errors: `401` not the owner, `403` NFT is not from our collection, `404` NFT is not owned by the redeemer,
`405` jetton wallet already set, `406` not enough TON, `408` not the pending owner, `409` not a basechain address,
`0xffff` unknown op.

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
npx blueprint run deployRedeemer --testnet [collection]   # saves addresses to deployments.json
npx blueprint run depositGum --testnet         # from the wallet that holds GUM; asks for confirmation
npx blueprint run redeemVoucher --testnet      # redeem as a user
npx blueprint run manageRedeemer --testnet     # status, withdraw TON/GUM, pause, amounts, rescue, owner change (propose / accept)
```

Scripts verify that the address you enter is really the redeemer (not its GUM wallet or the GUM master) and offer the
address saved in `deployments.json` by default. **Never send GUM to the redeemer's GUM wallet address**: jettons sent there
are lost; deposit only with `depositGum` (or a jetton transfer to the redeemer address with `forward_ton_amount > 0`).

Current deployments are listed in [`deployments.json`](deployments.json). The testnet contracts there and the live redeem
page were deployed before the 2026-11-08 audit fixes and run the old code; redeploy the collection, minter and redeemer
and then the page to test the current version.

**Deployment order:** first the collection from [nft-voucher](https://github.com/gumCommunity/nft-voucher), then the redeemer.
`deployRedeemer` checks on-chain that the pinned item code matches the collection before deploying anything.

After deploying, put the addresses into `web/.env.local` and run `cd web && npm run deploy` (see [web/README.md](web/README.md)).

## Notes

- The GUM transfer of a redemption carries 0.1 TON from the redeemer; with the real GUM wallet it costs ~0.003 TON
  (including the user's new jetton wallet) and the rest returns to the redeemer (jetton `response_destination` =
  redeemer). The user receives only GUM and the 1 nanoTON that carries the comment. Withdrawals attach 0.05 TON per
  transfer.
- The collection owner can mint vouchers and therefore effectively controls the GUM on the redeemer. Keep the collection
  owner (minter admin) and redeemer owner keys safe, preferably in a multisig wallet.
- Test on testnet first and get an audit before mainnet.

## License

MIT, see [LICENSE](LICENSE).
