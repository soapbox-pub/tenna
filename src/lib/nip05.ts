/**
 * NIP-05: asking a domain which key answers to a name.
 *
 * One `GET https://<domain>/.well-known/nostr.json?name=<name>`, and the only
 * thing taken out of it is the key — and the relays it names for that key,
 * which are hints and nothing more.
 *
 * What a lookup means here is narrow, and worth being explicit about. It is a
 * claim by whoever controls the domain, over TLS, that a name maps to a key.
 * It is not a fact about the key, and the key's owner is not asked. So nothing
 * downstream may treat the *name* as the identity: the key it resolves to is
 * the identity, and in this app that means an `nsite://<domain>/` URL resolves
 * to a pubkey, the pubkey gives the canonical `siteId`, and the `siteId` is
 * what the site's origin, storage and permissions are keyed by. A domain
 * repointed at a different key is a different site, with none of the old
 * site's storage and none of its grants — which is the property that makes
 * accepting a name safe at all.
 */

/** How long a name→key answer is reused before the domain is asked again. */
const TTL_MS = 10 * 60_000;

/** A `nostr.json` is a stranger's document; this is all that is read out of it. */
export interface Nip05Result {
  /** 64-char lowercase hex. */
  pubkey: string;
  /** Relays the document named for that key, if any. */
  relays: string[];
}

const cache = new Map<string, { result: Nip05Result; fetchedAt: number }>();

/**
 * Resolve `name@domain` to a key, or null if it doesn't resolve to one.
 *
 * Null for every kind of failure — no such name, a document that isn't one, a
 * server that isn't there — because the caller does the same thing in each
 * case and saying which would only be a way to tell a stranger's server apart
 * from a stranger's network.
 */
export async function lookupNip05(
  domain: string,
  name: string,
  signal?: AbortSignal,
): Promise<Nip05Result | null> {
  const key = `${name}@${domain}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.result;

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  try {
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      names?: Record<string, string>;
      relays?: Record<string, string[]>;
    };

    const pubkey = body.names?.[name];
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return null;

    const relays = Array.isArray(body.relays?.[pubkey]) ? body.relays[pubkey] : [];

    const result: Nip05Result = {
      pubkey,
      // Filtered here as well as where they are used: a relay hint off this
      // document becomes a websocket connection, and `wss:` is the only thing
      // that should.
      relays: relays.filter((relay) => typeof relay === 'string' && relay.startsWith('wss://')),
    };

    cache.set(key, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}
