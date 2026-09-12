/**
 * What was opened lately, newest first.
 *
 * A list of wall addresses stripped of their hints — the same keys
 * {@link wallUriKey} makes — and nothing else. Not the tile, not the manifest,
 * not a name: those are all had from somewhere that already holds them, and a
 * second copy here would be a second copy to keep true. What this knows is the
 * order, which nothing else does.
 *
 * It is written on every launch and read by the search bar, which is a thing
 * nobody waits for, so it lives in localStorage and is read synchronously.
 * Entries are kept for things that have since come off the wall or been
 * uninstalled: the reader decides what it can still open, and dropping an
 * address here would lose the one site a person opens by searching for it.
 */
import { APP_ID } from '@/lib/tenna';
import { wallUriKey } from '@/lib/wallUri';

const STORAGE_KEY = `${APP_ID}:recents`;

/**
 * How many launches back the list goes.
 *
 * Long enough that the handful of apps a person actually uses are all on it,
 * short enough that it is a memory rather than a history — the search bar
 * shows the top of it and nothing scrolls to the bottom.
 */
const LIMIT = 16;

/**
 * The list as it stands, held so that repeated reads hand back the same array.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders on
 * anything new, so a fresh array per read would be an infinite loop.
 */
let cache: string[] | null = null;

const listeners = new Set<() => void>();

/** A site's canonical subdomain, as a key on this list. */
export function siteKey(siteId: string): string {
  return wallUriKey({ kind: 'nsite', id: siteId, relays: [] });
}

/** A device app's package and activity, as a key on this list. */
export function appKey(app: { packageName: string; activityName: string }): string {
  return wallUriKey({ kind: 'app', ...app, label: null });
}

/** Only the shape survives a round trip through localStorage; check it. */
function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!Array.isArray(value)) return [];
    return value.filter((key): key is string => typeof key === 'string').slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** The keys of what was opened lately, newest first. */
export function getRecents(): string[] {
  return (cache ??= read());
}

/**
 * Put something at the top of the list.
 *
 * Moving rather than adding: opening the same app twice says it is the most
 * recent thing, not that it is two of the recent things.
 */
export function recordLaunch(key: string): void {
  const next = [key, ...getRecents().filter((existing) => existing !== key)].slice(0, LIMIT);
  cache = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Full or unavailable. The list still stands for this run of the app.
  }

  for (const listener of listeners) listener();
}

/** Watch the list, including changes made in another tab. */
export function subscribeRecents(listener: () => void): () => void {
  listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = null;
    listener();
  };

  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
