import { createContext } from "react";

import type { DittoTheme } from "@/lib/dittoTheme";

export type Theme = "dark" | "light" | "system";

export interface RelayMetadata {
  /** List of relays with read/write permissions */
  relays: { url: string; read: boolean; write: boolean }[];
  /** Unix timestamp of when the relay list was last updated */
  updatedAt: number;
}

/** Blossom server list metadata (BUD-03 / kind 10063), mirroring RelayMetadata for parity. */
export interface BlossomServerMetadata {
  /** Ordered list of Blossom server URLs (most trusted/reliable first per BUD-03). */
  servers: string[];
  /** Unix timestamp of when the server list was last updated (from kind 10063 created_at). */
  updatedAt: number;
}

/**
 * The Ditto profile theme (kind 16767) Tenna is wearing, and whose it is.
 *
 * Kept beside the relay and Blossom lists rather than in a query, because it
 * decides what colour the first frame of a cold start is. A theme read off a
 * relay after paint is a theme the user watches the app change into.
 *
 * `theme` is null once it is known that the user has none — which is a
 * different thing from `profileTheme` itself being null, meaning nobody is
 * signed in or nobody has been asked yet.
 */
export interface ThemeMetadata {
  /** Whose theme this is. Another account gets its own, never this one. */
  pubkey: string;
  /** The parsed event, or null where the user has published no theme. */
  theme: DittoTheme | null;
  /** Unix timestamp of the kind 16767 this came from, or 0 for "none found". */
  updatedAt: number;
}

/**
 * Somebody else's theme, worn for as long as their screen is up.
 *
 * Three states rather than two. `undefined` is nobody asking, and the app
 * wears whatever the logged-in user's own `profileTheme` says. A theme is a
 * screen saying "wear this instead" — a publisher's page, which is that
 * person's page and should be in that person's colours, the way a visitor to
 * their Ditto profile sees it. `null` is the same screen saying "wear nothing"
 * for a publisher who has never published a theme: their page drawn in the
 * visitor's colours would be a claim neither of them made, so it falls back to
 * Tenna's own.
 *
 * Not persisted, and deliberately: it belongs to a screen rather than to the
 * app, and a cold start should open in the user's own colours whatever page it
 * was closed on.
 */
export type ThemeOverride = DittoTheme | null | undefined;

export interface AppConfig {
  /**
   * Whether the app draws light or dark.
   *
   * Only consulted while no profile theme is on: a theme names its own
   * background and its own text colour, which settles the question outright.
   */
  theme: Theme;
  /** NIP-65 relay list metadata */
  relayMetadata: RelayMetadata;
  /** User's kind 10063 Blossom server list. */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * When true, the app's default Blossom servers are merged with the user's
   * servers (app servers first, deduped). When false, only the user's servers
   * are used.
   */
  useAppBlossomServers: boolean;
  /** The logged-in user's Ditto theme, or null when Tenna wears its own. */
  profileTheme: ThemeMetadata | null;
  /**
   * Whether the introduction has been through once on this device.
   *
   * Set by finishing it and equally by skipping it: what it records is that
   * the user has been shown, not that they agreed. It stays false for somebody
   * who signs in without ever seeing it, which costs nothing — the gate asks
   * about the login first, and a signed-in user is never held up by this.
   */
  onboarded: boolean;
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
  /** Whose theme the app is wearing instead of the user's, if anyone's. */
  themeOverride: ThemeOverride;
  /**
   * Wear somebody else's theme, or stop. Set by the screen that borrows one
   * and cleared when it closes — see `useWearTheme`, which is how to say this.
   */
  setThemeOverride: (override: ThemeOverride) => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * The theme the app is actually wearing: the borrowed one where a screen has
 * asked for it, and the user's own everywhere else.
 *
 * One function rather than the expression written twice, because two places
 * need the answer and they must not disagree — `AppProvider` to put it on the
 * document, and `useActiveTheme` for the things a stylesheet cannot draw.
 */
export function resolveActiveTheme(
  config: AppConfig,
  override: ThemeOverride,
): DittoTheme | null {
  if (override !== undefined) return override;
  return config.profileTheme?.theme ?? null;
}
