/**
 * Resolve an nsite's files from Blossom servers using the sha256 manifest
 * embedded in its NIP-5A event (`path` tags).
 */
import type { NostrEvent } from '@nostrify/nostrify';

import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import { isNsiteKind, NSITE_NAMED_KIND } from '@/lib/nsiteSubdomain';

/**
 * Build the path→sha256 manifest from a nsite event's `path` tags.
 * Each path tag has the format: ["path", "/file/path", "<sha256>"]
 */
export function buildManifest(event: NostrEvent): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === 'path' && tag[1] && tag[2]) {
      manifest.set(tag[1], tag[2]);
    }
  }
  return manifest;
}

/**
 * Whether an event is an nsite that can actually be served: it needs a name to
 * be addressed by and an `/index.html` to open on.
 */
export function isServableNsite(event: NostrEvent): boolean {
  const named = event.kind !== NSITE_NAMED_KIND || Boolean(event.tags.find(([n]) => n === 'd')?.[1]);
  const hasIndex = event.tags.some(
    ([name, path, sha256]) => name === 'path' && path === '/index.html' && sha256,
  );
  return isNsiteKind(event.kind) && named && hasIndex;
}

/**
 * Resolve the Blossom servers for a nsite event.
 * Prefers the `server` tags on the event; falls back to the app defaults.
 */
export function resolveServers(event: NostrEvent): string[] {
  const eventServers = event.tags
    .filter(([name]) => name === 'server')
    .map(([, url]) => url)
    .filter((url) => {
      try { new URL(url); return true; } catch { return false; }
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
 * Fetch a blob for the given sha256 by trying Blossom servers.
 *
 * If a server previously succeeded (the "preferred" server), it is tried
 * first. On success the preferred server is reinforced; on failure we fall
 * through to the remaining servers in order.
 */
export async function fetchFromBlossom(sha256: string, servers: string[]): Promise<Response> {
  let lastError: unknown;

  async function tryServer(server: string): Promise<Response | null> {
    const base = server.replace(/\/+$/, '');
    const url = `${base}/${sha256}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        preferredServer = server;
        return res;
      }
    } catch (err) {
      lastError = err;
    }
    return null;
  }

  if (preferredServer && servers.includes(preferredServer)) {
    const res = await tryServer(preferredServer);
    if (res) return res;
  }

  for (const server of servers) {
    if (server === preferredServer) continue;
    const res = await tryServer(server);
    if (res) return res;
  }

  throw lastError ?? new Error(`Failed to fetch blob ${sha256} from all servers`);
}
