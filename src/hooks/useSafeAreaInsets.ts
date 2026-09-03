import { useEffect, useState } from 'react';

import {
  readSafeAreaInsets,
  safeAreaInsetsEqual,
  type SafeAreaInsets,
} from '@/lib/safeArea';

/**
 * The device's current safe-area insets, in CSS pixels.
 *
 * Re-measures on rotation and on any viewport resize, since the system bars
 * can appear, disappear, or swap edges. The identity only changes when a
 * value actually does, so this is safe to depend on in effects.
 */
export function useSafeAreaInsets(): SafeAreaInsets {
  const [insets, setInsets] = useState<SafeAreaInsets>(readSafeAreaInsets);

  useEffect(() => {
    const measure = () => {
      const next = readSafeAreaInsets();
      setInsets((prev) => (safeAreaInsetsEqual(prev, next) ? prev : next));
    };

    // The insets change a frame or two *after* the resize on Android, once
    // the bars have settled, so measure again on the next frame too.
    const onResize = () => {
      measure();
      requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return insets;
}
