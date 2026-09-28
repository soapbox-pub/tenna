/** Where `npm run idb` writes the bundle. */
export const OUTPUT: string;

/** Where `npm run idb` writes the vault. */
export const VAULT_OUTPUT: string;

/** The bundled engine, as text. */
export function buildIndexedDB(options?: { minify?: boolean }): Promise<string>;

/** The bundled vault, as text. */
export function buildVault(options?: { minify?: boolean }): Promise<string>;
