import { Address, Cell } from '@ton/core';
import { TONAPI_BASE, TONAPI_KEY } from './config';
import { contentHash } from './payload';

type StackItem = { type: 'num'; num: string } | { type: 'cell'; cell: string } | { type: 'null' } | { type: string; [k: string]: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(TONAPI_BASE + path, { headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {} });
        if (res.status === 429 && attempt < 6) {
            await sleep(1100 * (attempt + 1)); // free tier: ~1 request per second
            continue;
        }
        if (!res.ok) throw new Error(`tonapi ${res.status}: ${await res.text()}`);
        return res.json() as Promise<T>;
    }
}

async function runGet(address: string, method: string, args: string[] = []): Promise<StackItem[]> {
    const q = args.map((a) => `args=${encodeURIComponent(a)}`).join('&');
    const r = await api<{ success: boolean; exit_code: number; stack: StackItem[] }>(
        `/v2/blockchain/accounts/${encodeURIComponent(address)}/methods/${method}${q ? '?' + q : ''}`,
    );
    if (!r.success) throw new Error(`${method} failed with exit code ${r.exit_code}`);
    return r.stack;
}

// tonapi returns numbers as hex strings, negative ones as "-0x1"; BigInt() cannot parse a negative hex string
const num = (s: StackItem) => {
    if (s.type !== 'num') return 0n;
    const v = (s as { num: string }).num;
    return v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v);
};
const cell = (s: StackItem) => Cell.fromBoc(Buffer.from((s as { cell: string }).cell, 'hex'))[0];
const addrOpt = (s: StackItem): Address | null => {
    if (s.type !== 'cell') return null;
    const a = cell(s).beginParse().loadAddressAny();
    return a instanceof Address ? a : null;
};

export type RedeemerState = { gumBalance: bigint; paused: boolean; jettonWalletSet: boolean; redeemedCount: bigint };

export async function getRedeemerState(redeemer: string): Promise<RedeemerState> {
    const s = await runGet(redeemer, 'get_redeemer_data');
    return { jettonWalletSet: addrOpt(s[2]) !== null, gumBalance: num(s[3]), redeemedCount: num(s[4]), paused: num(s[5]) !== 0n };
}

export async function getDenomination(redeemer: string, suffix: string): Promise<bigint> {
    // tonapi parses big integers (int257) only as 0x-prefixed hex
    return num((await runGet(redeemer, 'get_denomination', ['0x' + contentHash(suffix).toString(16)]))[0]);
}

export type NftData = { owner: Address | null; burned: boolean; contentSuffix: string };

export async function getNftData(nft: string): Promise<NftData> {
    const s = await runGet(nft, 'get_nft_data');
    const owner = addrOpt(s[3]);
    let contentSuffix = '';
    try {
        contentSuffix = cell(s[4]).beginParse().loadStringTail();
    } catch {
        /* not a voucher content */
    }
    return { owner, burned: num(s[0]) !== 0n && owner === null, contentSuffix };
}

export type NftItem = { address: string; name: string; image?: string; index: bigint };

export async function getUserVouchers(owner: string, collection: string): Promise<NftItem[]> {
    const r = await api<{ nft_items: any[] }>(
        `/v2/accounts/${encodeURIComponent(owner)}/nfts?collection=${encodeURIComponent(collection)}&limit=1000&indirect_ownership=false`,
    );
    return r.nft_items.map((i) => ({
        address: i.address,
        index: BigInt(i.index ?? 0),
        name: i.metadata?.name ?? `Voucher #${i.index}`,
        image: i.previews?.find((p: any) => p.resolution === '500x500')?.url ?? i.metadata?.image,
    }));
}

export async function getTonBalance(address: string): Promise<bigint> {
    const r = await api<{ balance: number | string }>(`/v2/accounts/${encodeURIComponent(address)}`);
    return BigInt(r.balance);
}

/** Logical time of the account's last transaction (changes whenever the NFT processes a message). */
export async function getLastLt(address: string): Promise<bigint> {
    const r = await api<{ last_transaction_lt?: number | string }>(`/v2/blockchain/accounts/${encodeURIComponent(address)}`);
    return BigInt(r.last_transaction_lt ?? 0);
}
