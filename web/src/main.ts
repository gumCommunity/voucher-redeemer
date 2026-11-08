import './polyfills';
import './style.css';
import { Address } from '@ton/core';
import { CHAIN, THEME, TonConnectUI, UserRejectsError, type ConnectedWallet } from '@tonconnect/ui';
import { COLLECTION_ADDRESS, EXPLORER, GUM_DECIMALS, IS_CONFIGURED, MANIFEST_URL, NETWORK, REDEEMER_ADDRESS, VOUCHER_KINDS } from './config';
import { buildRedeemMessage, REDEEM_TX_AMOUNT } from './payload';
import { getDenomination, getLastLt, getNftData, getRedeemerState, getTonBalance, getUserVouchers, type NftItem, type RedeemerState } from './tonapi';

// ---------- texts (edit to translate) ----------
const T = {
    title: 'Redeem Gumcoin Vouchers',
    subtitle: 'Send your NFT voucher to the redeemer contract and receive GUM in your wallet. The voucher is burned.',
    connectFirst: 'Connect your wallet to see your vouchers.',
    wrongNetwork: (n: string) => `Your wallet is connected to another network. Please switch it to ${n}.`,
    loading: 'Loading…',
    noVouchers: 'There are no Gumcoin vouchers in this wallet.',
    pool: 'Available in the pool',
    paused: 'Redemption is temporarily paused',
    notReady: 'The redeemer is not set up yet',
    youGet: 'You get',
    redeem: 'Redeem',
    unknownKind: 'This voucher is not accepted',
    poolEmpty: 'Not enough GUM in the pool',
    lowTon: (need: string) => `You need at least ${need} TON for fees`,
    confirmInWallet: 'Confirm the transaction in your wallet…',
    rejected: 'Transaction cancelled.',
    sent: 'Transaction sent, waiting for confirmation…',
    processing: 'The redeemer received your voucher, sending GUM…',
    success: (gum: string) => `Done! ${gum} GUM have been sent to your wallet.`,
    returned: 'The voucher came back to your wallet: redemption is not available right now. Please try again later.',
    stuck: 'The voucher is at the redeemer but was not processed. Please contact support with the NFT address:',
    timeout: 'No confirmation yet. Check your wallet history and reload the page.',
    error: 'Error:',
    feeNote: (ton: string) => `${ton} TON is attached to the transaction for fees; the unused part is returned.`,
    notConfigured: 'This page is not configured yet: redeemer and collection addresses are missing.',
};
// -----------------------------------------------

const chain = NETWORK === 'mainnet' ? CHAIN.MAINNET : CHAIN.TESTNET;
const redeemerRaw = IS_CONFIGURED ? Address.parse(REDEEMER_ADDRESS).toRawString() : '';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
};

function fmtUnits(units: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const int = new Intl.NumberFormat('en-US').format(units / base);
    const frac = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${int}.${frac.slice(0, 4)}` : int;
}
const fmtGum = (u: bigint) => fmtUnits(u, GUM_DECIMALS);
const fmtTon = (u: bigint) => fmtUnits(u, 9);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- layout ----------
const app = document.getElementById('app')!;
const header = $('header');
const brand = $('div', 'brand');
brand.append($('h1', '', T.title), $('p', 'muted', T.subtitle));
const connectRoot = $('div');
connectRoot.id = 'connect';
header.append(brand, connectRoot);

const poolBar = $('div', 'pool');
const notice = $('div', 'notice hidden');
const list = $('div', 'list');
const footer = $('p', 'muted small', T.feeNote(fmtTon(REDEEM_TX_AMOUNT)));
app.append(header, poolBar, notice, list, footer);

function showNotice(text: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info', link?: { href: string; label: string }) {
    notice.className = `notice ${kind}`;
    notice.replaceChildren(document.createTextNode(text + (link ? ' ' : '')));
    if (link) {
        const a = $('a', '', link.label);
        a.href = link.href;
        a.target = '_blank';
        a.rel = 'noopener';
        notice.append(a);
    }
}
const hideNotice = () => (notice.className = 'notice hidden');

// ---------- state ----------
const tonConnect = new TonConnectUI({
    manifestUrl: MANIFEST_URL,
    buttonRootId: 'connect',
    language: 'en',
    uiPreferences: { theme: THEME.LIGHT },
});

let pool: RedeemerState | null = null;
const amounts = new Map<string, bigint>(); // content suffix -> GUM units
let busy = false;

async function loadPool() {
    try {
        pool = await getRedeemerState(REDEEMER_ADDRESS);
        for (const k of VOUCHER_KINDS) amounts.set(k, await getDenomination(REDEEMER_ADDRESS, k));
        renderPool();
    } catch (e) {
        poolBar.textContent = `${T.error} ${(e as Error).message}`;
    }
}

function renderPool() {
    if (!pool) return;
    poolBar.replaceChildren();
    const v = $('div');
    v.append($('span', 'muted', `${T.pool}: `), $('strong', '', `${fmtGum(pool.gumBalance)} GUM`));
    poolBar.append(v);
    if (pool.paused) poolBar.append($('div', 'badge warn', T.paused));
    if (!pool.jettonWalletSet) poolBar.append($('div', 'badge warn', T.notReady));
}

async function render(wallet: ConnectedWallet | null) {
    list.replaceChildren();
    if (!wallet) {
        list.append($('p', 'empty', T.connectFirst));
        return;
    }
    if (wallet.account.chain !== chain) {
        list.append($('p', 'empty', T.wrongNetwork(NETWORK)));
        return;
    }
    list.append($('p', 'empty', T.loading));
    const user = wallet.account.address;
    try {
        const [items, tonBalance] = [await getUserVouchers(user, COLLECTION_ADDRESS), await getTonBalance(user)];
        list.replaceChildren();
        if (!items.length) {
            list.append($('p', 'empty', T.noVouchers));
            return;
        }
        for (const item of items.sort((a, b) => (a.index < b.index ? -1 : 1))) {
            list.append(card(item, user, tonBalance));
        }
    } catch (e) {
        list.replaceChildren($('p', 'empty', `${T.error} ${(e as Error).message}`));
    }
}

function card(item: NftItem, user: string, tonBalance: bigint): HTMLElement {
    const el = $('div', 'card');
    const img = $('img');
    img.alt = '';
    if (item.image) img.src = item.image;
    const body = $('div', 'card-body');
    const title = $('div', 'card-title', item.name);
    const get = $('div', 'muted', `${T.youGet}: …`);
    const btn = $('button', 'btn', T.redeem);
    btn.disabled = true;
    const why = $('div', 'small warn-text');
    body.append(title, get, btn, why);
    el.append(img, body);

    // find the voucher kind on-chain (exactly what the redeemer checks)
    getNftData(item.address)
        .then(({ contentSuffix }) => {
            const amount = amounts.get(contentSuffix) ?? 0n;
            get.textContent = amount ? `${T.youGet}: ${fmtGum(amount)} GUM` : T.unknownKind;
            let reason = '';
            if (!amount) reason = T.unknownKind;
            else if (!pool || !pool.jettonWalletSet) reason = T.notReady;
            else if (pool.paused) reason = T.paused;
            else if (pool.gumBalance < amount) reason = T.poolEmpty;
            else if (tonBalance < REDEEM_TX_AMOUNT + 20_000_000n) reason = T.lowTon(fmtTon(REDEEM_TX_AMOUNT + 20_000_000n));
            why.textContent = reason;
            btn.disabled = !!reason;
            btn.onclick = () => redeem(item, user, amount, btn);
        })
        .catch((e) => (why.textContent = `${T.error} ${(e as Error).message}`));
    return el;
}

async function redeem(item: NftItem, user: string, amount: bigint, btn: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    const nftLink = { href: `${EXPLORER}/${Address.parse(item.address).toString({ testOnly: NETWORK === 'testnet' })}`, label: 'NFT' };
    try {
        const ltBefore = await getLastLt(item.address);
        showNotice(T.confirmInWallet);
        await tonConnect.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 300,
            network: chain,
            messages: [buildRedeemMessage(item.address, REDEEMER_ADDRESS, user, BigInt(Date.now()))],
        });
        showNotice(T.sent);
        const result = await track(item.address, user, ltBefore);
        if (result === 'burned') showNotice(T.success(fmtGum(amount)), 'ok');
        else if (result === 'returned') showNotice(T.returned, 'warn');
        else if (result === 'stuck') showNotice(T.stuck, 'err', nftLink);
        else showNotice(T.timeout, 'warn', nftLink);
        await loadPool();
        await render(tonConnect.wallet as ConnectedWallet | null);
    } catch (e) {
        if (e instanceof UserRejectsError) showNotice(T.rejected, 'warn');
        else showNotice(`${T.error} ${(e as Error).message}`, 'err');
        btn.disabled = false;
    } finally {
        busy = false;
    }
}

/** Follow the voucher: user -> redeemer -> burned (or back to the user). */
async function track(nft: string, user: string, ltBefore: bigint): Promise<'burned' | 'returned' | 'stuck' | 'timeout'> {
    const userRaw = Address.parse(user).toRawString();
    let atRedeemerPolls = 0;
    for (let i = 0; i < 60; i++) {
        await sleep(4000);
        let d, lt;
        try {
            d = await getNftData(nft);
            lt = await getLastLt(nft);
        } catch {
            continue; // indexer hiccup, try again
        }
        if (d.burned) return 'burned';
        const owner = d.owner?.toRawString();
        if (owner === redeemerRaw) {
            if (atRedeemerPolls++ === 0) showNotice(T.processing);
            if (atRedeemerPolls > 15) return 'stuck'; // ~1 min at the redeemer without processing
        } else if (owner === userRaw && lt !== ltBefore) {
            // the NFT processed our transfer but belongs to the user again: it went to the redeemer and came back
            // (or the transfer itself failed) — either way the voucher is safe in the wallet
            return 'returned';
        }
    }
    return 'timeout';
}

// ---------- start ----------
if (!IS_CONFIGURED) {
    showNotice(T.notConfigured, 'err');
    footer.remove();
} else {
    hideNotice();
    loadPool();
    tonConnect.onStatusChange((w) => render(w));
    tonConnect.connectionRestored.then(() => {
        if (!tonConnect.wallet) render(null);
    });
}
