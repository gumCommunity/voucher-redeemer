// Compiled code of gumCommunity/nft-voucher, pinned in contracts/nft-voucher/ (see README there).
import { Address, beginCell, Cell, contractAddress } from '@ton/core';
import { readFileSync } from 'fs';
import { join } from 'path';

export const NFT_ITEM_CODE_HASH = '8544104bb7d757282fe1a2530f2f3cf11efd1a81e50c515aff3a9d19bf086901';
export const NFT_COLLECTION_CODE_HASH = '811a47eca28786e7bf8a9b96e06c4bb8845f8bae7b774bd5a4bf9fea453517ba';

function load(name: string, expectedHash: string): Cell {
    const json = JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'nft-voucher', `${name}.compiled.json`), 'utf8'));
    const cell = Cell.fromBoc(Buffer.from(json.hex, 'hex'))[0];
    const hash = cell.hash().toString('hex');
    if (hash !== expectedHash) throw new Error(`${name}: pinned code hash ${hash} != expected ${expectedHash}`);
    return cell;
}

export const loadNftItemCode = () => load('NftVoucherItem', NFT_ITEM_CODE_HASH);
export const loadNftCollectionCode = () => load('NftVoucherCollection', NFT_COLLECTION_CODE_HASH);

/** Address of item #index of `collection` with `itemCode` (what the collection's get_nft_address_by_index returns). */
export const nftItemAddress = (collection: Address, index: bigint, itemCode: Cell = loadNftItemCode()) =>
    contractAddress(0, { code: itemCode, data: beginCell().storeUint(index, 64).storeAddress(collection).endCell() });
