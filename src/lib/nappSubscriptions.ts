import type { NostrFilter } from '@nostrify/nostrify';
import { z } from 'zod';

/** What a site asks to be told about: some filters, on some relays. */
export interface NappSubscription {
  filters: NostrFilter[];
  relays: string[];
}

/** Ceilings on what one site may ask for. Mirrored on the native side. */
export const NAPP_LIMITS = {
  subscriptions: 10,
  filters: 10,
  relays: 10,
  /** Longest list a filter may carry: ids, authors, tag values. */
  list: 500,
} as const;

function isRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'wss:' || url.protocol === 'ws:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const relaySchema = z
  .string()
  .trim()
  .refine(isRelayUrl, 'Relays must be ws:// or wss:// URLs')
  .transform((url) => url.replace(/\/+$/, ''));

const subscriptionSchema = z.object({
  filters: z
    .array(z.record(z.string(), z.unknown()), 'Each subscription needs a filters array')
    .min(1, 'Each subscription needs at least one filter')
    .max(NAPP_LIMITS.filters, `At most ${NAPP_LIMITS.filters} filters per subscription`),
  relays: z
    .array(relaySchema, 'Each subscription needs a relays array')
    .min(1, 'Each subscription needs at least one relay')
    .max(NAPP_LIMITS.relays, `At most ${NAPP_LIMITS.relays} relays per subscription`),
});

const subscriptionsSchema = z
  .array(subscriptionSchema, 'Subscriptions must be an array')
  .max(NAPP_LIMITS.subscriptions, `At most ${NAPP_LIMITS.subscriptions} subscriptions`);

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Filter ${key} must be an array of strings`);
  }
  if (value.length > NAPP_LIMITS.list) throw new Error(`Filter ${key} is too long`);
  return value;
}

function intList(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item))) {
    throw new Error('Filter kinds must be an array of integers');
  }
  if (value.length > NAPP_LIMITS.list) throw new Error('Filter kinds is too long');
  return value as number[];
}

/**
 * Keep only what a relay can index, and insist the filter names something.
 *
 * `limit` is dropped: a standing subscription has no use for one. A filter
 * with nothing but `since` or `until` would be every event the relay sees,
 * and is refused.
 */
function normalizeFilter(filter: Record<string, unknown>, index: number): NostrFilter {
  const clean: Record<string, unknown> = {};
  let named = false;

  for (const [key, value] of Object.entries(filter)) {
    switch (key) {
      case 'ids':
      case 'authors':
        clean[key] = stringList(value, key);
        named = true;
        break;
      case 'kinds':
        clean[key] = intList(value);
        named = true;
        break;
      case 'since':
      case 'until':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`Filter ${key} must be a number`);
        }
        clean[key] = Math.floor(value);
        break;
      case 'search':
        if (typeof value !== 'string') throw new Error('Filter search must be a string');
        clean[key] = value;
        named = true;
        break;
      case 'limit':
        break;
      default:
        if (/^#[a-zA-Z]$/.test(key)) {
          clean[key] = stringList(value, key);
          named = true;
        } else {
          throw new Error(`Filter key ${key} is not supported`);
        }
    }
  }

  if (!named) {
    throw new Error(
      `A filter in subscription ${index} matches everything; name ids, authors, kinds, a tag or a search`,
    );
  }

  return clean as NostrFilter;
}

/**
 * Check and tidy what a site passed to `napp.push.set()`.
 *
 * Throws an `Error` whose message can be handed straight back to the site.
 * The native side runs the same rules again on what it stores.
 */
export function normalizeNappSubscriptions(input: unknown): NappSubscription[] {
  const parsed = subscriptionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid subscriptions');
  }

  return parsed.data.map((subscription, index) => ({
    filters: subscription.filters.map((filter) => normalizeFilter(filter, index)),
    relays: [...new Set(subscription.relays)],
  }));
}
