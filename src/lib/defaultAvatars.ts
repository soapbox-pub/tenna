/**
 * The dozen pictures offered to somebody who has just made an account.
 *
 * These are Signal's, rendered out of the vector drawables in Signal-Android
 * (`res/drawable/ic_avatar_*.xml`) onto the pastel backgrounds its own
 * `AvatarColor` table pairs them with, in the order `Avatars.kt` lists them.
 * Signal is GPL-3.0-or-later and Tenna is AGPL-3.0-or-later, which is a
 * licence it may be combined under.
 *
 * They exist because the alternative first thing a new account does is
 * nothing: a profile with no picture is the one everybody has, and a wall of
 * grey circles is how a network looks empty. One tap is a low enough price for
 * a face, and the pictures are ordinary enough that nobody is stuck with a
 * personality they did not choose.
 *
 * The file is the thing that gets uploaded, not a name Tenna resolves later —
 * a `picture` pointing at `tenna.pub` would be a picture that dies with this
 * app. See `uploadDefaultAvatar`.
 */
export interface DefaultAvatar {
  /** The file under `public/avatars`, and the label read out to a screen reader. */
  id: string;
  /** What it is a picture of. */
  label: string;
}

export const DEFAULT_AVATARS: readonly DefaultAvatar[] = [
  { id: 'abstract-01', label: 'Green face' },
  { id: 'abstract-02', label: 'Blue face' },
  { id: 'abstract-03', label: 'Orange face' },
  { id: 'cat', label: 'Cat' },
  { id: 'dog', label: 'Dog' },
  { id: 'fox', label: 'Fox' },
  { id: 'tucan', label: 'Toucan' },
  { id: 'sloth', label: 'Sloth' },
  { id: 'dinosaur', label: 'Dinosaur' },
  { id: 'pig', label: 'Pig' },
  { id: 'incognito', label: 'Incognito' },
  { id: 'ghost', label: 'Ghost' },
];

/**
 * Where one of them lives in this build.
 *
 * A literal path built from an id, and the ids are the list above — this value
 * ends up in `src` and in a CSS `url()`, so it may never be built from
 * anything that came off a relay.
 */
export function defaultAvatarUrl(id: string): string {
  return `/avatars/${id}.png`;
}

/**
 * Fetch one of these out of the app bundle as a file ready to upload.
 *
 * The picture has to leave Tenna to be any use. A kind 0 naming a path on
 * whatever host this build was served from is a profile picture that works in
 * Tenna and nowhere else, and stops working here the day the path changes.
 * So the bytes are read back out of the bundle and pushed to a Blossom server
 * like any other upload, and what goes in the event is that server's URL.
 */
export async function defaultAvatarFile(id: string): Promise<File> {
  const response = await fetch(defaultAvatarUrl(id));
  if (!response.ok) throw new Error(`No such avatar: ${id}`);
  const blob = await response.blob();
  return new File([blob], `${id}.png`, { type: 'image/png' });
}
