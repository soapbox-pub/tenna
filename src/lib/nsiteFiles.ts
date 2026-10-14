/**
 * Resolve an nsite's files from Blossom servers using the sha256 manifest
 * embedded in its NIP-5A event (`path` tags).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from '@nostrify/nostrify';

import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import {
  getNsiteSubdomain,
  isNsiteKind,
  isNsiteId,
  NSITE_NAMED_KIND,
} from '@/lib/nsiteSubdomain';

/**
 * A blob name: lowercase hex, thirty-two bytes of it.
 *
 * Every sha256 in a manifest is checked against this before it is used for
 * anything, because it is used as a path. On the web that path is the tail of
 * a Blossom URL, where a `../` would walk out of the server's blob namespace;
 * on Android the same string names a file in the shared cache directory, where
 * it would walk out of the cache and into the app's private storage. Neither
 * is a place a stranger's event tag gets to point.
 */
const BLOB_NAME = /^[0-9a-f]{64}$/;

/** Whether a manifest's sha256 is a name a blob can actually have. */
export function isBlobName(value: string | undefined): value is string {
  return typeof value === 'string' && BLOB_NAME.test(value);
}

/**
 * Build the path→sha256 manifest from a nsite event's `path` tags.
 * Each path tag has the format: ["path", "/file/path", "<sha256>"]
 *
 * A tag whose hash is not a hash is dropped rather than refused: a manifest is
 * a stranger's event, and one bad tag in it is no reason to lose the site.
 */
export function buildManifest(event: NostrEvent): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === 'path' && tag[1]?.startsWith('/') && isBlobName(tag[2])) {
      manifest.set(tag[1], tag[2]);
    }
  }
  return manifest;
}

/**
 * Whether an event is an nsite that can actually be served: it needs an
 * address to be reached at and an `/index.html` to open on.
 *
 * The address is the test a named site can fail in a way that matters. Its id
 * is built from the `d` tag, and has to be a hostname under `nsite.localhost`
 * because that is what the whole app then treats it as — so a `d` tag that is
 * missing, longer than a label, or carrying anything a hostname cannot hold
 * makes the site unaddressable, and this is the gate every list of sites
 * passes through before one is drawn, stored or opened. See `isNsiteId`.
 */
export function isServableNsite(event: NostrEvent): boolean {
  if (!isNsiteKind(event.kind)) return false;
  // A named site with no `d` tag has no address of its own; without this it
  // would fall back to its author's npub and impersonate their root site.
  if (event.kind === NSITE_NAMED_KIND && !event.tags.find(([n]) => n === 'd')?.[1]) return false;
  if (!isNsiteId(getNsiteSubdomain(event))) return false;

  return event.tags.some(
    ([name, path, hash]) => name === 'path' && path === '/index.html' && isBlobName(hash),
  );
}

/**
 * Resolve the Blossom servers for a nsite event.
 * Prefers the `server` tags on the event; falls back to the app defaults.
 *
 * `https:` only. The scheme comes off a stranger's event and decides what the
 * app does with the string: anything else is either refused by the platform
 * anyway (the CSP on the web, the cleartext policy on Android) or is not a
 * fetch at all, and a `server` tag naming the device's own storage is not a
 * mirror.
 */
export function resolveServers(event: NostrEvent): string[] {
  const eventServers = event.tags
    .filter(([name]) => name === 'server')
    .map(([, url]) => url)
    .filter((url) => {
      try { return new URL(url).protocol === 'https:'; } catch { return false; }
    });

  return eventServers.length > 0 ? eventServers : APP_BLOSSOM_SERVERS.servers;
}

/**
 * Module-level preferred server. Once a Blossom server successfully serves
 * a blob, it is promoted here so subsequent requests try it first — avoiding
 * the round-trip penalty of 404s on servers that don't have the content.
 */
let preferredServer: string | null = null;

/**
 * Fetch the blob for a sha256, trying Blossom servers, and verify it.
 *
 * If a server previously succeeded (the "preferred" server), it is tried
 * first. On success the preferred server is reinforced; on failure we fall
 * through to the remaining servers in order.
 *
 * **The bytes are hashed before they are returned.** A Blossom server is named
 * by a `server` tag on the manifest, which is the publisher's choice and not
 * the reader's, and every blob is fetched by content address — so the one
 * thing that makes a mirror untrusted infrastructure rather than a host is
 * checking that what came back is what was asked for. Without it a server
 * serves a site whatever it likes, and on Android the answer is cached under
 * the requested name in a store every site shares, so it serves *another*
 * site whatever it likes. A server that fails the check is treated as a server
 * that did not have the blob, and the next one is tried.
 */
export async function fetchFromBlossom(
  hash: string,
  servers: string[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBlobName(hash)) throw new Error(`Not a blob name: ${hash}`);

  let lastError: unknown;

  async function tryServer(server: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const base = server.replace(/\/+$/, '');
    const url = `${base}/${hash}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytesToHex(sha256(bytes)) !== hash) {
        lastError = new Error(`${base} served something other than ${hash}`);
        return null;
      }

      preferredServer = server;
      return bytes;
    } catch (err) {
      lastError = err;
    }
    return null;
  }

  if (preferredServer && servers.includes(preferredServer)) {
    const bytes = await tryServer(preferredServer);
    if (bytes) return bytes;
  }

  for (const server of servers) {
    if (server === preferredServer) continue;
    const bytes = await tryServer(server);
    if (bytes) return bytes;
  }

  throw lastError ?? new Error(`Failed to fetch blob ${hash} from all servers`);
}
