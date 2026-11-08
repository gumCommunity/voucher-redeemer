import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';

// Gumcoin voucher redeemer settings.

// GUM jetton master per network (decimals = 9 on both)
export const GUM_MASTER = {
    mainnet: Address.parse('EQC8prgBYisGDdRZ2ZmmJHom1-a6WZDT5atEBn1ZvTA--GUM'),
    testnet: Address.parse('0:81fa8e5475134728231b174561afc2b09859b98c89db8db915daebe21eccdb41'),
};

export function gumMasterFor(provider: NetworkProvider): Address {
    const net = provider.network();
    if (net === 'mainnet' || net === 'testnet') return GUM_MASTER[net];
    throw new Error(`No GUM master configured for network "${net}"`);
}

export const GUM_DECIMALS = 9;

// GUM paid for each voucher kind (item content suffix -> whole GUM)
export const VOUCHER_KINDS = [
    { content: '0.json', gum: 10_000n },
    { content: '1.json', gum: 5_000n },
    { content: '2.json', gum: 1_000n },
];

export const toGum = (whole: bigint | number | string) => {
    const [i, f = ''] = String(whole).split('.');
    return BigInt(i) * 10n ** BigInt(GUM_DECIMALS) + BigInt((f + '0'.repeat(GUM_DECIMALS)).slice(0, GUM_DECIMALS) || '0');
};

export const fromGum = (units: bigint) => {
    const base = 10n ** BigInt(GUM_DECIMALS);
    const frac = (units % base).toString().padStart(GUM_DECIMALS, '0').replace(/0+$/, '');
    return (units / base).toString() + (frac ? '.' + frac : '');
};
