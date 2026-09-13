import { TileArtwork, TileImage } from '@/components/Tile';

/**
 * Another app's icon, drawn the way Android means it to be.
 *
 * Android has two kinds of icon and they are not the same object. An adaptive
 * one is an oversized square meant to be cut — it goes behind Tenna's squircle
 * full-bleed, which is what the wall does with a device app. A legacy one is a
 * finished picture that has already been cut by whoever drew it, and putting
 * that behind a mask cuts it twice.
 *
 * The same rule the wall uses in `NativeAppIcon`, because it is the same
 * question. Something with no icon at all — a remote app, a web page — gets
 * its initial on a colour off its name, which is still a mark.
 *
 * Expects a positioned parent to fill.
 */
export function AppMark({
  name,
  icon,
  adaptive,
}: {
  name: string;
  icon: string | null;
  adaptive: boolean;
}) {
  if (!icon) return <TileArtwork name={name} />;
  if (adaptive) return <TileArtwork name={name} iconUrl={icon} fit="cover" />;
  return <TileImage src={icon} name={name} />;
}
