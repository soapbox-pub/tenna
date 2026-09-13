import { AndroidBadge } from '@/components/AndroidBadge';
import { TileArtwork, TileImage } from '@/components/Tile';
import type { IconFit } from '@/hooks/useNsiteApp';

/**
 * How a site's own artwork sits on a tile.
 *
 * Present only for a site, and that is what tells the two kinds of icon apart
 * here. A launcher icon arrives finished — Android has already decided its
 * shape and what is behind it — where a site's icon is a picture that needs a
 * tile put under it, in the colour the site named and cut to the shape the
 * wall cuts everything to.
 */
export interface MarkTile {
  fit: IconFit;
  background: string | null;
}

/**
 * Another app's icon, drawn the way the wall draws it.
 *
 * Android has two kinds of icon and they are not the same object. An adaptive
 * one is an oversized square meant to be cut — it goes behind Tenna's squircle
 * full-bleed, which is what the wall does with a device app. A legacy one is a
 * finished picture that has already been cut by whoever drew it, and putting
 * that behind a mask cuts it twice.
 *
 * The same rule the wall uses in `NativeAppIcon`, because it is the same
 * question — and for the same reason the badge is here too: an app on the
 * phone is drawn on the wall with the robot in its corner, and a person who
 * has to recognise one in a list of authorized apps, or in a sheet asking to
 * sign, is recognising the thing they have already seen on their home screen.
 *
 * Something with no icon at all — a remote app, a web page — gets its initial
 * on a colour off its name, which is still a mark.
 *
 * Expects a positioned parent to fill.
 */
export function AppMark({
  name,
  icon,
  adaptive,
  tile,
  badge = false,
  badgeClassName,
}: {
  name: string;
  icon: string | null;
  /** Whether an Android icon is a full square with a shape still to cut. */
  adaptive: boolean;
  /** Set when the icon is a site's artwork rather than a launcher's. */
  tile?: MarkTile;
  /** Whether this is an app on the phone, and so leaves Tenna. */
  badge?: boolean;
  /** The colour the badge is cut out of, where it isn't the wallpaper. */
  badgeClassName?: string;
}) {
  const art = !icon ? (
    <TileArtwork name={name} background={tile?.background} />
  ) : tile ? (
    <TileArtwork name={name} iconUrl={icon} fit={tile.fit} background={tile.background} />
  ) : adaptive ? (
    <TileArtwork name={name} iconUrl={icon} fit="cover" />
  ) : (
    <TileImage src={icon} name={name} />
  );

  return (
    <>
      {art}
      {badge && <AndroidBadge className={badgeClassName} />}
    </>
  );
}
