import { resolveActiveTheme } from '@/contexts/AppContext';
import { useAppContext } from '@/hooks/useAppContext';
import type { DittoTheme } from '@/lib/dittoTheme';

/**
 * The theme the app is wearing right now, whosever it is.
 *
 * Nearly everything follows the theme without being told — the colours are CSS
 * properties on the document and the whole palette is derived from them. This
 * is for the two things a stylesheet cannot answer: the wallpaper, which is a
 * picture rather than a colour, and whether Tenna should draw its own weather
 * over the wall, which it only does when it is wearing its own face.
 */
export function useActiveTheme(): DittoTheme | null {
  const { config, themeOverride } = useAppContext();
  return resolveActiveTheme(config, themeOverride);
}
