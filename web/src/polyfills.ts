// @ton/core needs Buffer in the browser. Imported first in main.ts.
import { Buffer } from 'buffer';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
