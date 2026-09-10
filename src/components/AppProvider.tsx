import { ReactNode, useEffect } from 'react';
import { z } from 'zod';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme, type RelayMetadata, type BlossomServerMetadata, type ThemeMetadata } from '@/contexts/AppContext';
import {
  applyDittoTheme,
  DittoThemeSchema,
  loadThemeFonts,
  themeIsDark,
  type DittoTheme,
} from '@/lib/dittoTheme';

interface AppProviderProps {
  children: ReactNode;
  /** Application storage key */
  storageKey: string;
  /** Default app configuration */
  defaultConfig: AppConfig;
}

// Zod schema for RelayMetadata validation
const RelayMetadataSchema = z.object({
  relays: z.array(z.object({
    url: z.url(),
    read: z.boolean(),
    write: z.boolean(),
  })),
  updatedAt: z.number(),
}) satisfies z.ZodType<RelayMetadata>;

// Zod schema for BlossomServerMetadata validation
const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.url()),
  updatedAt: z.number(),
}) satisfies z.ZodType<BlossomServerMetadata>;

/**
 * Zod schema for the cached profile theme.
 *
 * Local storage is same-origin, so this is not a trust boundary in the way the
 * relay was — but the theme is the one thing in this config that ends up in a
 * stylesheet, and re-checking it on the way out costs nothing. It is the same
 * schema the event was parsed through.
 */
const ThemeMetadataSchema = z.object({
  pubkey: z.string(),
  theme: DittoThemeSchema.nullable(),
  updatedAt: z.number(),
}) satisfies z.ZodType<ThemeMetadata>;

// Zod schema for AppConfig validation
const AppConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  relayMetadata: RelayMetadataSchema,
  blossomServerMetadata: BlossomServerMetadataSchema,
  useAppBlossomServers: z.boolean(),
  profileTheme: ThemeMetadataSchema.nullable(),
}) satisfies z.ZodType<AppConfig>;

export function AppProvider(props: AppProviderProps) {
  const {
    children,
    storageKey,
    defaultConfig,
  } = props;

  // App configuration state with localStorage persistence
  const [rawConfig, setConfig] = useLocalStorage<Partial<AppConfig>>(
    storageKey,
    {},
    {
      serialize: JSON.stringify,
      deserialize: (value: string) => {
        const parsed = JSON.parse(value);
        return AppConfigSchema.partial().parse(parsed);
      }
    }
  );

  // Generic config updater with callback pattern
  const updateConfig = (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => {
    setConfig(updater);
  };

  const config = { ...defaultConfig, ...rawConfig };

  const appContextValue: AppContextType = {
    config,
    updateConfig,
  };

  // The user's own theme, where they have published one. Its colours settle
  // the light/dark question on their own, so `config.theme` is only asked
  // when there is no theme to ask instead.
  const profileTheme = config.profileTheme?.theme ?? null;

  useApplyProfileTheme(profileTheme);
  useApplyTheme(profileTheme ? (themeIsDark(profileTheme) ? 'dark' : 'light') : config.theme);

  return (
    <AppContext.Provider value={appContextValue}>
      {children}
    </AppContext.Provider>
  );
}

/**
 * Put the document into the user's Ditto theme, or back into Tenna's own.
 *
 * The colours land synchronously, before paint, because they come out of
 * local storage with the rest of the config — a cold start opens in the user's
 * colours rather than changing into them a second later. The fonts cannot: the
 * files have to be fetched, so the app is drawn in the fallback stack for as
 * long as that takes and reflows once when they arrive.
 */
function useApplyProfileTheme(theme: DittoTheme | null) {
  useEffect(() => {
    applyDittoTheme(theme);
  }, [theme]);

  // Not cancelled on cleanup: `loadThemeFonts` is what owns the families, and
  // it drops a fetch superseded by a later one itself. A cleanup that cleared
  // them would fight the effect that replaced it.
  useEffect(() => {
    void loadThemeFonts(theme);
  }, [theme]);
}

/**
 * Hook to apply theme changes to the document root
 */
function useApplyTheme(theme: Theme) {
  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';

      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  // Handle system theme changes when theme is set to "system"
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = () => {
      const root = window.document.documentElement;
      root.classList.remove('light', 'dark');

      const systemTheme = mediaQuery.matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);
}