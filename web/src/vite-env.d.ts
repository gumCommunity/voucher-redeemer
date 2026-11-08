/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_NETWORK?: string;
    readonly VITE_REDEEMER_ADDRESS?: string;
    readonly VITE_COLLECTION_ADDRESS?: string;
    readonly VITE_TONAPI_KEY?: string;
}
