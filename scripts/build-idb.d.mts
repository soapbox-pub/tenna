/** Where `npm run idb` writes the bundle. */
export const OUTPUT: string;

/** The bundled script, as text. */
export function buildIndexedDB(options?: { minify?: boolean }): Promise<string>;
