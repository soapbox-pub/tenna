import { useActiveTheme } from '@/hooks/useActiveTheme';
import { isSignerSheet } from '@/hooks/useSignerPrompt';

/**
 * The picture a theme puts behind the wall.
 *
 * A `bg` tag on kind 16767 names an image or a video and how to lay it out:
 * `cover`, which fills the screen and crops, or `tile`, which repeats it at
 * its own size. Both are drawn here rather than on the wall itself, because
 * the wall is one screen of several and a wallpaper is behind all of them —
 * including a publisher's page, which wears that publisher's theme and so
 * their wallpaper with it. See `useActiveTheme`.
 *
 * It sits at `-z-10`, which puts it under everything in the document and over
 * the page's own background colour — so `body` still paints the theme's
 * background underneath, and it is what shows through a picture with alpha in
 * it or one that never loads. Nothing between here and the root establishes a
 * stacking context, which is what that depends on; a `relative z-0` anywhere
 * up the tree would trap the layer above it and hide the whole wall.
 *
 * A site drawn over the wall covers this, and should: `NsiteViewer` and
 * `NsiteApp` are opaque black, and a site's window is the site's own.
 */
export function ThemeBackground() {
  const media = useActiveTheme()?.media;

  // Not behind the signing sheet. That window is one question asked on behalf
  // of another application, and a wallpaper across it would be Tenna dressing
  // a screen that is not its own.
  if (isSignerSheet()) return null;

  if (!media) return null;

  // The URL was validated as plain `https:` with no character that could end a
  // CSS string early — see `safeHttpsUrl`. React sets both of these through
  // the DOM rather than by writing CSS text, so neither is parsed as a
  // stylesheet in the first place.
  if (media.video) {
    return (
      <video
        aria-hidden="true"
        src={media.url}
        autoPlay
        loop
        muted
        playsInline
        // A wallpaper is not a video anybody is watching, so it is never
        // downloaded until it is on screen and never fetched over a metered
        // connection ahead of the app itself.
        preload="none"
        className="pointer-events-none fixed inset-0 -z-10 h-full w-full object-cover motion-reduce:hidden"
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        backgroundImage: `url("${media.url}")`,
        backgroundSize: media.mode === 'tile' ? 'auto' : 'cover',
        backgroundRepeat: media.mode === 'tile' ? 'repeat' : 'no-repeat',
        backgroundPosition: 'center',
      }}
    />
  );
}
