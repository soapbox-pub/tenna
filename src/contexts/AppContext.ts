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
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
