import { Camera, Loader2, UserRound } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { toast } from '@/hooks/useToast';
import { DEFAULT_AVATARS, defaultAvatarFile, defaultAvatarUrl } from '@/lib/defaultAvatars';
import { impactLight } from '@/lib/haptics';
import { useUploadFile } from '@/hooks/useUploadFile';
import { cn } from '@/lib/utils';

/** The big button, matching the one the rest of the introduction uses. */
const PRIMARY = 'h-13 w-full rounded-full text-base font-semibold';

/** What the picture is going to be, once somebody has chosen one. */
type Picture =
  /** Nothing yet. */
  | { kind: 'none' }
  /** One of the twelve. Not uploaded until the user is finished choosing. */
  | { kind: 'default'; id: string }
  /** Their own photograph, already on a Blossom server. */
  | { kind: 'uploaded'; url: string };

interface ProfileSetupProps {
  /**
   * Whose profile this is allowed to be.
   *
   * The account made a moment ago, and nobody else. See the guard in
   * {@link ProfileSetup} — a kind 0 signed by the wrong key silently replaces
   * a real person's profile, and there is no undo for that.
   */
  expectedPubkey: string | undefined;
  /** Move on, whether or not anything was published. */
  onFinish: () => void;
}

/**
 * A name and a face, asked for once, at the only moment the user is definitely
 * paying attention.
 *
 * Both are optional and the screen says so. An account with neither still
 * works everywhere — but it is the account nobody can tell apart from every
 * other new one, and a network of grey circles reads as an empty network even
 * when it is full. So there are twelve pictures on the screen and picking one
 * is a single tap.
 *
 * Shaped after Signal's own set-up screen, which is the one this is trying to
 * feel as short as: one avatar, one field, and a way past it.
 */
export function ProfileSetup({ expectedPubkey, onFinish }: ProfileSetupProps) {
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<Picture>({ kind: 'none' });
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();

  const busy = isSaving || isUploading;

  /** What to draw in the circle at the top, before anything is published. */
  const preview =
    picture.kind === 'default'
      ? defaultAvatarUrl(picture.id)
      : picture.kind === 'uploaded'
        ? picture.url
        : undefined;

  const handlePhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared straight away so that picking the same file twice still fires.
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: 'Pick an image', variant: 'destructive' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'That image is too big', description: '5MB at most.', variant: 'destructive' });
      return;
    }

    try {
      const tags = await uploadFile(file);
      const url = tags[0]?.[1];
      if (url) setPicture({ kind: 'uploaded', url });
    } catch {
      toast({
        title: "Couldn't upload that",
        description: 'Try again, or pick one of the pictures below.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Publish the profile and move on.
   *
   * Anything that goes wrong here loses a name and a picture, which are worth
   * a toast and not worth being stuck on: the account exists either way, and
   * both are editable from Settings forever after. So every failure still
   * calls `onFinish`.
   */
  const handleFinish = async () => {
    const trimmed = name.trim();
    if (!trimmed && picture.kind === 'none') {
      onFinish();
      return;
    }

    // The signer is whoever `useCurrentUser` says it is, and this screen has no
    // say in that. If the new login somehow is not the active one, signing here
    // would publish over whichever account is — refuse instead.
    if (!user || !expectedPubkey || user.pubkey !== expectedPubkey) {
      toast({
        title: 'Profile not saved',
        description: 'This account is not the active one yet. You can set it up from Settings.',
        variant: 'destructive',
      });
      onFinish();
      return;
    }

    setIsSaving(true);

    try {
      let pictureUrl: string | undefined;

      if (picture.kind === 'uploaded') {
        pictureUrl = picture.url;
      } else if (picture.kind === 'default') {
        // Uploaded now rather than on the tap that chose it, so that trying
        // all twelve costs one upload instead of twelve.
        const tags = await uploadFile(await defaultAvatarFile(picture.id));
        pictureUrl = tags[0]?.[1];
      }

      const metadata: Record<string, string> = {};
      if (trimmed) metadata.name = trimmed;
      if (pictureUrl) metadata.picture = pictureUrl;

      await publishEvent({ kind: 0, content: JSON.stringify(metadata) });
    } catch {
      toast({
        title: "Couldn't save your profile",
        description: 'Your account is fine. Set a name and picture from Settings.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
      onFinish();
    }
  };

  return (
    <>
      <div className="flex flex-1 flex-col justify-center gap-7 py-6">
        <div className="space-y-3">
          <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight">
            Set up your profile
          </h1>
          <p className="text-pretty text-lg leading-relaxed text-foreground/70">
            A name and a face, so people know who they are talking to. Both are
            optional, and both can be changed later.
          </p>
        </div>

        {/* The picture as it will be, at the size a profile shows one, with the
            way to replace it hung off the corner where a badge goes. */}
        <div className="flex justify-center">
          <div className="relative">
            <div className="size-28 overflow-hidden rounded-full bg-foreground/10">
              {preview ? (
                <img src={preview} alt="" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-foreground/40">
                  <UserRound aria-hidden="true" className="size-12" />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="Choose a photo"
              className="absolute -bottom-1 -right-1 flex size-11 items-center justify-center rounded-full border-4 border-background bg-primary text-primary-foreground outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-foreground disabled:opacity-60"
            >
              {isUploading ? (
                <Loader2 aria-hidden="true" className="size-5 animate-spin" />
              ) : (
                <Camera aria-hidden="true" className="size-5" />
              )}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhoto}
              className="hidden"
            />
          </div>
        </div>

        <div>
          <label htmlFor="onboarding-name" className="sr-only">
            Your name
          </label>
          <Input
            id="onboarding-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="done"
            maxLength={64}
            className="h-13 rounded-xl text-center text-base"
          />
        </div>

        {/* Sized by the screen rather than by a column count: five across on
            the narrowest phone worth drawing for, more as there is room, and
            never smaller than a thumb. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-2">
          {DEFAULT_AVATARS.map((avatar) => {
            const chosen = picture.kind === 'default' && picture.id === avatar.id;
            return (
              <button
                key={avatar.id}
                type="button"
                aria-label={avatar.label}
                aria-pressed={chosen}
                onClick={() => {
                  impactLight();
                  setPicture({ kind: 'default', id: avatar.id });
                }}
                disabled={busy}
                className={cn(
                  'aspect-square overflow-hidden rounded-full outline-none transition-transform',
                  'hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  chosen && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                )}
              >
                {/* Eagerly, deliberately. These are twelve small files out of
                    the app's own bundle, and lazily the last one never loaded
                    at all: the grid sits at the bottom of a scroll container
                    and the observer never fired for the cell below the fold,
                    leaving an empty circle where the ghost should be. */}
                <img
                  src={defaultAvatarUrl(avatar.id)}
                  alt=""
                  decoding="async"
                  className="size-full object-cover"
                />
              </button>
            );
          })}
        </div>
      </div>

      <footer className="mt-6 shrink-0 space-y-3">
        <Button onClick={handleFinish} disabled={busy} className={PRIMARY}>
          {isSaving ? (
            <>
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
              Saving…
            </>
          ) : (
            'Next'
          )}
        </Button>
        <Button
          variant="ghost"
          onClick={onFinish}
          disabled={busy}
          className="h-12 w-full rounded-full text-base font-medium text-foreground/75 hover:text-foreground"
        >
          Skip for now
        </Button>
      </footer>
    </>
  );
}
