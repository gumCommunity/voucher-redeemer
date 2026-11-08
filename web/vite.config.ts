import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // works from any sub-path, e.g. https://gumcoin.org/redeem/
    build: { target: 'es2020' },
});
