#!/usr/bin/env node

/**
 * Tenna's IndexedDB, bundled into the one script iOS injects.
 *
 * `src/lib/idb/entry.ts` and everything it imports become a single IIFE at
 * `ios/App/NsiteNotify/NsiteIndexedDB.js`, which both iOS targets carry as a
 * resource: the app injects it into a site's pages, and the notification
 * extension runs it ahead of a site's service worker. Like the icons, it is
 * build output — gitignored and remade by `npm run idb`, which `dev`,
 * `build`, and `test` run first — so the TypeScript is the only copy anyone
 * edits.
 *
 * The conformance tests build it too, through `buildIndexedDB()`, so what
 * they run is byte for byte what ships.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/lib/idb/entry.ts");
export const OUTPUT = join(ROOT, "ios/App/NsiteNotify/NsiteIndexedDB.js");

/** The bundled script, as text. */
export async function buildIndexedDB({ minify = true } = {}) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    root: ROOT,
    resolve: { alias: { "@": join(ROOT, "src") } },
    build: {
      write: false,
      // Private fields and static blocks stay as written: iOS 17's WebKit
      // has both, and a downlevelled private field is a WeakMap a site could
      // reach through the prototype chain.
      target: "safari17",
      minify,
      sourcemap: false,
      lib: {
        entry: ENTRY,
        formats: ["iife"],
        name: "TennaIndexedDB",
        fileName: () => "NsiteIndexedDB.js",
      },
      rollupOptions: { output: { extend: false } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === "chunk");
  if (!chunk) throw new Error("The IndexedDB bundle produced no script.");
  return chunk.code;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  const code = await buildIndexedDB();
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, code);
}
