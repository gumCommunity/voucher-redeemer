// Compiled code of gumCommunity/nft-voucher, pinned in contracts/nft-voucher/ (see README there).
import { Cell } from '@ton/core';
import { readFileSync } from 'fs';
import { join } from 'path';

export const NFT_ITEM_CODE_HASH = '8544104bb7d757282fe1a2530f2f3cf11efd1a81e50c515aff3a9d19bf086901';
export const NFT_COLLECTION_CODE_HASH = '8e5aab17e2e503bec75c2f453b9dacf11a98bbb2cc202994710952a7271c7780';

function load(name: string, expectedHash: string): Cell {
    const json = JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'nft-voucher', `${name}.compiled.json`), 'utf8'));
    const cell = Cell.fromBoc(Buffer.from(json.hex, 'hex'))[0];
    const hash = cell.hash().toString('hex');
    if (hash !== expectedHash) throw new Error(`${name}: pinned code hash ${hash} != expected ${expectedHash}`);
    return cell;
}

export const loadNftItemCode = () => load('NftVoucherItem', NFT_ITEM_CODE_HASH);
export const loadNftCollectionCode = () => load('NftVoucherCollection', NFT_COLLECTION_CODE_HASH);
