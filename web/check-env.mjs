// Warns before deploying a page without contract addresses (it would show "not configured").
import { readFileSync, existsSync } from 'fs';

const env = {};
for (const f of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*(VITE_\w+)\s*=\s*(.*?)\s*$/);
        if (m) env[m[1]] = m[2];
    }
}
Object.assign(env, Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))));

const missing = ['VITE_REDEEMER_ADDRESS', 'VITE_COLLECTION_ADDRESS'].filter((k) => !env[k]);
console.log(`network: ${env.VITE_NETWORK || 'testnet'}`);
console.log(`redeemer: ${env.VITE_REDEEMER_ADDRESS || '-'}`);
console.log(`collection: ${env.VITE_COLLECTION_ADDRESS || '-'}`);
if (missing.length) console.warn(`\n⚠  ${missing.join(', ')} not set in web/.env.local — the page will show "not configured".\n`);
