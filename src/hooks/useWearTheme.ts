import { useEffect } from 'react';

import type { ThemeOverride } from '@/contexts/AppContext';
import { useAppContext } from '@/hooks/useAppContext';

/**
 * Wear somebody else's theme for as long as this screen is up.
 *
 * The theme goes on the whole app rather than on the subtree that asked for
 * it. That is not a shortcut — it is what a theme is: a background colour, an
 * ink, an accent and a wallpaper, and half of those are painted by `body` and
 * by the layer behind everything. A theme applied to a box would be a box in
 * somebody's colours sitting on a page in somebody else's.
 *
 * Pass `undefined` to borrow nothing, which is also what unmounting does —
 * the app goes back to the user's own theme on the way out, however the screen
 * is left. A screen still waiting to find out whose theme to wear should pass
 * `undefined` rather than `null` and keep the user's colours meanwhile: `null`
 * is a decision, and taking the user's theme off for the half second before
 * the relay answers is a flash of Tenna's own colours on the way into someone
 * else's page.
 */
export function useWearTheme(theme: ThemeOverride): void {
  const { setThemeOverride } = useAppContext();

  useEffect(() => {
    setThemeOverride(theme);
    return () => setThemeOverride(undefined);
  }, [theme, setThemeOverride]);
}
