import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NPool,
  NRelay,
  NStore,
} from '@nostrify/nostrify';

import { NSITE_KINDS } from '@/lib/nsiteSubdomain';

/**
 * The kinds worth keeping on disk.
 *
 * Every kind Tenna reads back, and nothing else. A cache is only as good as
 * what is in it when the app starts cold, and it is only as cheap as what it
 * declined to write — so this is an allowlist rather than a size limit or an
 * eviction policy. Tenna reads no public feeds and subscribes to no firehose;
 * everything it asks a relay for is on this list, so in practice the tap
 * writes what it sees and the list is there to say why.
 *
 * Growth is bounded without pruning. All of these but the snapshot kind are
 * replaceable or addressable, and the store supersedes older versions at the
 * same coordinate on write — so what accumulates is one manifest per site and
 * one profile per person, however many times either is fetched.
 */
const CACHED_KINDS = new Set<number>([
  0, // profile metadata
  3, // contact list
  10002, // NIP-65 relay list
  10063, // BUD-03 Blossom server list
  ...NSITE_KINDS, // NIP-5A manifests: root, named, snapshot
]);

/** Whether an event is one Tenna will want again on a cold start. */
function shouldCache(event: NostrEvent): boolean {
  return CACHED_KINDS.has(event.kind);
}

/**
 * A relay that writes everything it reads into a local store.
 *
 * Wraps another `NRelay` and passes every method through unchanged, mirroring
 * the events that come back into the store on the way past. The store write
 * is fire-and-forget and its failures are swallowed: a cache is a convenience,
 * and nothing that reads a relay should ever wait on one or fail with one.
 */
class CachingRelay implements NRelay {
  constructor(
    private readonly relay: NRelay,
    private readonly cache: (events: NostrEvent[]) => void,
  ) {}

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const events = await this.relay.query(filters, opts);
    this.cache(events);
    return events;
  }

  async event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.relay.event(event, opts);
    // Only once the relay has taken it. An event the network rejected has no
    // business being read back out of the cache as though it were published.
    this.cache([event]);
  }

  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    const source = this.relay.req(filters, opts);
    const cache = this.cache;

    // Each EVENT is mirrored as it streams past; what the consumer sees is
    // exactly what the relay sent.
    return (async function* () {
      for await (const msg of source) {
        if (msg[0] === 'EVENT') cache([msg[2]]);
        yield msg;
      }
    })();
  }

  close(): Promise<void> {
    return this.relay.close();
  }
}

/**
 * The app's relay pool, with everything it reads kept on disk.
 *
 * Tenna asks a relay the same handful of questions every time it starts, and
 * until the answers arrive there is nothing to draw: a wall of sites whose
 * manifests haven't come back is an empty wall, and a profile that hasn't come
 * back is a blank name. None of those answers changed since last time, and all
 * of them were already on the wire once. So every event that comes out of the
 * pool goes into an `NStore`, and the hooks read that store before the network
 * — see `useCacheFirstSeed`.
 *
 * {@link relay} and {@link group} are wrapped too, which is the whole point
 * here: the wall, the catalog and address lookup all talk to the nsite relay
 * directly rather than through the pool's own router, so a tap on `query`
 * alone would miss every manifest the app has ever fetched.
 */
export class CachingPool implements NRelay {
  constructor(
    private readonly pool: NPool,
    private readonly store: NStore,
  ) {}

  /**
   * Write eligible events to the store, and don't wait for it.
   *
   * `NIndexedDB` already batches writes and defers them to idle time, so
   * calling this per read costs a `Set` lookup and a promise nobody awaits.
   */
  private cache = (events: NostrEvent[]): void => {
    const worth = events.filter(shouldCache);
    if (worth.length === 0) return;

    void (async () => {
      try {
        await Promise.all(worth.map((event) => this.store.event(event)));
      } catch {
        // Best effort. A cache that couldn't be written is a cache miss later.
      }
    })();
  };

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    const events = await this.pool.query(filters, opts);
    this.cache(events);
    return events;
  }

  async event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.pool.event(event, opts);
    // See CachingRelay.event: the network's answer comes first.
    this.cache([event]);
  }

  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    const source = this.pool.req(filters, opts);
    const cache = this.cache;

    return (async function* () {
      for await (const msg of source) {
        if (msg[0] === 'EVENT') cache([msg[2]]);
        yield msg;
      }
    })();
  }

  // No `count`. `NStore` makes it optional so a caller can tell whether the
  // thing it holds supports COUNT at all, and neither `NPool` nor anything in
  // this app does — declaring one here that throws would only take that answer
  // away.

  /** One named relay, tapped the same way the pool is. */
  relay(url: string): NRelay {
    return new CachingRelay(this.pool.relay(url), this.cache);
  }

  /** A group of relays, tapped the same way the pool is. */
  group(urls: string[]): NRelay {
    return new CachingRelay(this.pool.group(urls), this.cache);
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}
