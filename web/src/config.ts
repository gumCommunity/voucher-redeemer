// Build-time settings. On GitHub they come from repository variables (Settings → Secrets and variables →
// Actions → Variables), locally from web/.env.local. See web/README.md.
const env = import.meta.env;

export const NETWORK: 'testnet' | 'mainnet' = env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

// Addresses of the deployed contracts (any format: EQ.., UQ.., 0:..)
export const REDEEMER_ADDRESS: string = env.VITE_REDEEMER_ADDRESS ?? '';
export const COLLECTION_ADDRESS: string = env.VITE_COLLECTION_ADDRESS ?? '';

// Optional tonapi.io client key (without it tonapi allows ~1 request per second; the page waits and retries)
export const TONAPI_KEY: string = env.VITE_TONAPI_KEY ?? '';

// tonconnect-manifest.json is served next to index.html
export const MANIFEST_URL = new URL('tonconnect-manifest.json', window.location.href).toString();

// Voucher kinds (item content suffixes); GUM amounts are read from the redeemer contract
export const VOUCHER_KINDS = ['0.json', '1.json', '2.json'];
export const GUM_DECIMALS = 9;

export const TONAPI_BASE = NETWORK === 'mainnet' ? 'https://tonapi.io' : 'https://testnet.tonapi.io';
export const EXPLORER = NETWORK === 'mainnet' ? 'https://tonviewer.com' : 'https://testnet.tonviewer.com';
export const IS_CONFIGURED = REDEEMER_ADDRESS !== '' && COLLECTION_ADDRESS !== '';
