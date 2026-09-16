import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ArrowLeft, Flashlight, FlashlightOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** How often a frame is looked at. Five a second is faster than a hand is steady. */
const SCAN_INTERVAL_MS = 200;

/** How long the camera has to produce a picture before we call it dead. */
const READY_TIMEOUT_MS = 6000;

interface QrScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * A code that was read.
   *
   * Return true to take it — the camera stops and the caller is expected to
   * close this. Return false to refuse it: scanning carries on and
   * {@link mismatch} is shown, which is what happens when the camera is
   * pointed at a code that is a perfectly good QR code and the wrong thing.
   */
  onScan: (value: string) => boolean;
  title?: string;
  /** What to point the camera at. */
  description?: string;
  /** What to say about a code that was read and refused. */
  mismatch?: string;
}

/**
 * A camera, looking for a QR code, over the whole screen.
 *
 * Whole-screen because that is what a viewfinder is for: the picture is the
 * thing being aimed, and a small one in the middle of a page asks someone to
 * aim a phone by watching a stamp. It is also what the platform does — the
 * scanner behind Android's own "Add network" fills the display — and it is
 * what lets the camera be held at arm's length and still be read.
 *
 * The whole of the decoding is the platform's own `BarcodeDetector`, which
 * costs nothing to ship and is the reason this is a component rather than a
 * dependency. Whether the device has one is {@link useQrScanning}'s question,
 * and callers are expected to have asked it before opening this — but it is
 * asked again here, because a device that answers no still has to say so
 * rather than show a black screen.
 *
 * The camera belongs to this: it is opened when this opens and closed when it
 * closes, including when the closing is the user pressing back. What a caller
 * manages is `open` and what to do with a code.
 *
 * The failures worth naming, each of which is otherwise a black screen:
 *
 *   - no `BarcodeDetector`, so nothing could read a code even if one were seen;
 *   - an insecure context, where `getUserMedia` does not exist;
 *   - permission refused, at the OS or at the web layer;
 *   - no camera on the device, or another app already holding it;
 *   - a stream that arrives and never paints, which is the shape a wedged
 *     capture pipeline takes — hence {@link READY_TIMEOUT_MS}.
 */
export function QrScanner({
  open,
  onOpenChange,
  onScan,
  title = 'Scan a code',
  description = 'Point the camera at the QR code.',
  mismatch = 'That code isn’t the one.',
}: QrScannerProps) {
  // A callback ref rather than a plain one: the dialog's content is portalled
  // and mounted lazily, so on the tick `open` turns true the element does not
  // exist yet. The flag beside it is what re-runs the effect at the moment it
  // does; the element itself is held in a ref because the effect writes to it.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [attached, setAttached] = useState(false);
  const attach = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setAttached(!!element);
  }, []);

  // Kept in a ref so that a caller passing a new function identity on every
  // render — which is the normal thing for a closure over local state — does
  // not tear the camera down and start it again.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  const [status, setStatus] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [torch, setTorch] = useState<MediaStreamTrack | null>(null);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!open || !attached || !video) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let scan: ReturnType<typeof setTimeout> | undefined;
    let ready: ReturnType<typeof setTimeout> | undefined;
    let painted: (() => void) | undefined;

    setStatus('starting');
    setError(null);
    setRefused(false);

    const fail = (message: string) => {
      if (stopped) return;
      stopped = true;
      setStatus('error');
      setError(message);
    };

    let detector: BarcodeDetector;
    try {
      if (typeof BarcodeDetector === 'undefined') throw new Error('unsupported');
      detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      fail('This device can’t read QR codes.');
      return;
    }

    const tick = async () => {
      if (stopped) return;

      // `detect` on a video with no frame in it throws; wait for one.
      if (video.readyState >= video.HAVE_CURRENT_DATA) {
        try {
          const [code] = await detector.detect(video);
          if (code?.rawValue && !stopped) {
            if (onScanRef.current(code.rawValue)) {
              stopped = true;
              return;
            }
            setRefused(true);
          }
        } catch {
          // A frame that could not be read is not news. The next one is along
          // in a fifth of a second.
        }
      }

      if (!stopped) scan = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
    };

    if (window.isSecureContext === false) {
      fail('The camera is only available over a secure connection.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fail('This device won’t give the app a camera.');
      return;
    }

    (async () => {
      try {
        stream = await openCamera();
      } catch (err) {
        fail(describeCameraError(err));
        return;
      }

      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // A muted inline video is allowed to play unasked, and if this one
        // somehow isn't, the timeout below is what says so.
      }

      if (stopped) return;

      const track = stream.getVideoTracks()[0];
      if (track?.getCapabilities?.().torch) setTorch(track);

      // Running means a picture, not a promise of one. A stream that resolves
      // and then never paints is the shape a camera held by another app takes,
      // and showing it as running would be showing a black square as success.
      painted = () => {
        clearTimeout(ready);
        if (!stopped) setStatus('running');
      };

      if (video.readyState >= video.HAVE_CURRENT_DATA) {
        painted();
      } else {
        video.addEventListener('loadeddata', painted, { once: true });
        ready = setTimeout(() => {
          fail('The camera didn’t start. Another app may be using it.');
        }, READY_TIMEOUT_MS);
      }

      void tick();
    })();

    return () => {
      stopped = true;
      clearTimeout(scan);
      clearTimeout(ready);
      if (painted) video.removeEventListener('loadeddata', painted);
      // Turning the lamp off is the track's business and it is about to be
      // stopped, which puts it out.
      for (const track of stream?.getTracks() ?? []) track.stop();
      video.srcObject = null;
      setTorch(null);
      setTorchOn(false);
    };
  }, [open, attached]);

  // Back closes the camera, the way it closes anything laid over a screen.
  // Left to the system it would go back in the router instead, which from here
  // means leaving the page that opened the camera — the user asked to stop
  // scanning, not to abandon what they were scanning for.
  useEffect(() => {
    if (!open) return;

    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => onOpenChange(false))
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {
        // No native shell to ask.
      });

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [open, onOpenChange]);

  const toggleTorch = async () => {
    if (!torch) return;
    const on = !torchOn;
    try {
      await torch.applyConstraints({ advanced: [{ torch: on }] });
      setTorchOn(on);
    } catch {
      // Some devices report the lamp and then refuse to light it. Nothing to
      // say about that which the user could act on.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // A screen, not a card: the centring and the width the dialog gives
        // everything else are undone here, and what is left of it is the part
        // worth keeping — a focus trap, and a thing the screen reader is told
        // is modal.
        className="inset-0 top-0 left-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 select-none gap-0 rounded-none border-0 bg-black p-0 sm:max-w-none"
        // Focus the screen itself rather than the first thing in it, which is
        // the back button and would sit here wearing a focus ring for as long
        // as the camera was open. There is nothing in here to type into, which
        // is also why the keyboard should not come up.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
      >
        <video
          ref={attach}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity',
            status !== 'running' && 'opacity-0',
          )}
          playsInline
          muted
        />

        {/* The window to aim through, and the dark everywhere else. A square
            rather than the whole screen because a QR code is square, and
            because something to aim at is the only instruction a viewfinder
            needs to give. */}
        {status === 'running' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[70%] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-3xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
          />
        )}

        <div className="relative flex h-full flex-col">
          <header className="flex items-start gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pt-safe-offset-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Back"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-white outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white"
            >
              <ArrowLeft aria-hidden="true" className="size-6" />
            </button>

            <div className="min-w-0 flex-1 pt-2">
              <DialogTitle className="text-xl font-semibold text-white">{title}</DialogTitle>
              <DialogDescription className="mt-1 text-base text-white/70">
                {description}
              </DialogDescription>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
            {status === 'starting' && (
              <>
                <Loader2 aria-hidden="true" className="size-8 animate-spin text-white/80" />
                <span className="sr-only">Starting the camera</span>
              </>
            )}

            {status === 'error' && <p className="text-base text-white/80">{error}</p>}
          </div>

          <div className="flex flex-col items-center gap-6 px-8 pb-safe-offset-8">
            {/* Under the viewfinder, where the eye already is, and only after
                a code has been read and turned down — a standing warning about
                codes that aren't the right one is noise until one is. */}
            {refused && status === 'running' && (
              <p
                role="status"
                className="rounded-full bg-black/60 px-4 py-2 text-center text-base text-white/90 backdrop-blur"
              >
                {mismatch}
              </p>
            )}

            {status === 'running' && torch && (
              <button
                type="button"
                onClick={() => void toggleTorch()}
                aria-label={torchOn ? 'Turn the light off' : 'Turn the light on'}
                aria-pressed={torchOn}
                className={cn(
                  'flex size-14 items-center justify-center rounded-full outline-none backdrop-blur transition-colors focus-visible:ring-2 focus-visible:ring-white',
                  torchOn
                    ? 'bg-white text-black hover:bg-white/90'
                    : 'bg-white/15 text-white hover:bg-white/25',
                )}
              >
                {torchOn ? (
                  <FlashlightOff aria-hidden="true" className="size-6" />
                ) : (
                  <Flashlight aria-hidden="true" className="size-6" />
                )}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The camera, preferring the one on the back.
 *
 * `ideal` rather than `exact`, so a device with only a front camera gets that
 * one instead of an `OverconstrainedError` — and the retry below is for the
 * ones that reject the preference anyway, which some WebViews do.
 */
async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    if (!isOverconstrained(err)) throw err;
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

function isOverconstrained(err: unknown): boolean {
  return err instanceof Error && err.name === 'OverconstrainedError';
}

/** What went wrong, in words that say what to do about it. */
function describeCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Tenna wasn’t allowed to use the camera.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'This device has no camera.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Another app is using the camera.';
    case 'OverconstrainedError':
      return 'This device’s camera can’t do what was asked of it.';
    default:
      return 'The camera couldn’t be opened.';
  }
}
