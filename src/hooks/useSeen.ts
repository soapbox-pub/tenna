import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element has been scrolled into view yet, and stays true after.
 *
 * A row in a list of apps costs something to draw — a trip to the package
 * manager for a device's icon, a Blossom round trip for a site's — and a list
 * is mostly rows nobody scrolls to. So a row asks for its artwork when it is
 * looked at.
 */
export function useSeen<T extends Element>() {
  const ref = useRef<T>(null);

  // Where there is no observer to ask, everything counts as looked at — which
  // is the honest answer for a list that cannot report being scrolled.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setSeen(true);
      },
      // A screen's worth of warning, so a row is drawn before it arrives.
      { rootMargin: '200px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return [ref, seen] as const;
}
