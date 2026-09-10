import { useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import { parseBlossomServerList } from '@/lib/appBlossom';
import { DITTO_THEME_KIND, parseDittoTheme } from '@/lib/dittoTheme';

/**
 * NostrSync - Syncs user's Nostr data
 *
 * This component runs globally to sync various Nostr data when the user logs in.
 * Currently syncs:
 * - NIP-65 relay list (kind 10002)
 * - BUD-03 Blossom server list (kind 10063)
 * - Ditto profile theme (kind 16767)
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();

  useEffect(() => {
    if (!user) return;

    const syncRelaysFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [10002], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        if (events.length > 0) {
          const event = events[0];

          // Only update if the event is newer than our stored data
          if (event.created_at > config.relayMetadata.updatedAt) {
            const fetchedRelays = event.tags
              .filter(([name]) => name === 'r')
              .map(([_, url, marker]) => ({
                url,
                read: !marker || marker === 'read',
                write: !marker || marker === 'write',
              }));

            if (fetchedRelays.length > 0) {
              console.log('Syncing relay list from Nostr:', fetchedRelays);
              updateConfig((current) => ({
                ...current,
                relayMetadata: {
                  relays: fetchedRelays,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync relays from Nostr:', error);
      }
    };

    syncRelaysFromNostr();
  }, [user, config.relayMetadata.updatedAt, nostr, updateConfig]);

  useEffect(() => {
    if (!user) return;

    const syncBlossomServersFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [10063], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        if (events.length > 0) {
          const event = events[0];

          // Only update if the event is newer than our stored data
          if (event.created_at > config.blossomServerMetadata.updatedAt) {
            const fetchedServers = parseBlossomServerList(event);

            if (fetchedServers.length > 0) {
              console.log('Syncing Blossom server list from Nostr:', fetchedServers);
              updateConfig((current) => ({
                ...current,
                blossomServerMetadata: {
                  servers: fetchedServers,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync Blossom servers from Nostr:', error);
      }
    };

    syncBlossomServersFromNostr();
  }, [user, config.blossomServerMetadata.updatedAt, nostr, updateConfig]);

  // The face Tenna wears. Read on the same terms as the two lists above, and
  // kept in the config for the same reason: it decides what colour the first
  // frame of the next cold start is, and a theme fetched after paint is a
  // theme the user watches the app change into.
  const themePubkey = config.profileTheme?.pubkey;
  const themeUpdatedAt = config.profileTheme?.updatedAt;
  const hasTheme = !!config.profileTheme;

  useEffect(() => {
    // Nobody signed in, so nobody's theme. Tenna goes back to its own.
    if (!user) {
      if (hasTheme) updateConfig((current) => ({ ...current, profileTheme: null }));
      return;
    }

    // Somebody else is signed in now. Cleared before the relay is asked rather
    // than after it answers: an account switch that leaves the app in the last
    // person's colours for a second is the one outcome worth a frame of
    // Tenna's own.
    if (hasTheme && themePubkey !== user.pubkey) {
      updateConfig((current) => ({ ...current, profileTheme: null }));
      return;
    }

    const syncThemeFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [DITTO_THEME_KIND], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) },
        );

        const event = events[0];

        // Nothing came back. That is "no theme" for a user who has never
        // published one, and "the relay didn't answer" for everyone else, and
        // there is no telling the two apart — `NPool.query` returns partial
        // results on a timeout rather than failing. So a miss never takes a
        // theme away, only fails to bring a new one, which is the same rule
        // `useAuthor` applies to a profile. The cost is that a theme deleted
        // outright stays until it is replaced.
        if (!event) {
          if (!hasTheme) {
            updateConfig((current) => ({
              ...current,
              profileTheme: { pubkey: user.pubkey, theme: null, updatedAt: 0 },
            }));
          }
          return;
        }

        if (event.created_at <= (themeUpdatedAt ?? 0)) return;

        // A theme that doesn't parse — a missing colour, a font behind a URL
        // that isn't https — is no theme rather than half a theme applied over
        // half of Tenna's.
        const theme = parseDittoTheme(event);

        updateConfig((current) => ({
          ...current,
          profileTheme: { pubkey: user.pubkey, theme, updatedAt: event.created_at },
        }));
      } catch (error) {
        console.error('Failed to sync profile theme from Nostr:', error);
      }
    };

    syncThemeFromNostr();
  }, [user, hasTheme, themePubkey, themeUpdatedAt, nostr, updateConfig]);

  return null;
}
