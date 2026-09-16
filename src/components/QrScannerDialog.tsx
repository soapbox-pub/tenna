import { Flashlight, FlashlightOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** How often a frame is looked at. Five a second is faster than a hand is steady. */
const SCAN_INTERVAL_MS = 200;

/** How long the camera has to produce a picture before we call it dead. */
const READY_TIMEOUT_MS = 6000;

interface QrScannerDialogProps {
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
 * A camera, looking for a QR code.
 *
 * The whole of the decoding is the platform's own `BarcodeDetector`, which
 * costs nothing to ship and is the reason this exists as a dialog rather than
 * as a dependency. Whether the device has one is {@link useQrScanning}'s
 * question, and callers are expected to have asked it before opening this —
 * but it is asked again here, because a device that answers no still has to
 * say so rather than show a black square.
 *
 * The camera belongs to the dialog: it is opened when this opens and closed
 * when it closes, including when the closing is the user pressing back. What a
 * caller manages is `open` and what to do with a code.
 *
 * The failures worth naming, each of which is otherwise a black square:
 *
 *   - no `BarcodeDetector`, so nothing could read a code even if one were seen;
 *   - an insecure context, where `getUserMedia` does not exist;
 *   - permission refused, at the OS or at the web layer;
 *   - no camera on the device, or another app already holding it;
 *   - a stream that arrives and never paints, which is the shape a wedged
 *     capture pipeline takes — hence {@link READY_TIMEOUT_MS}.
 */
export function QrScannerDialog({
  open,
  onOpenChange,
  onScan,
  title = 'Scan a code',
  description = 'Point the camera at the QR code.',
  mismatch = 'That code isn’t the one.',
}: QrScannerDialogProps) {
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
        className="max-w-sm select-none gap-0 overflow-hidden rounded-3xl p-0"
        // Focus the dialog itself rather than the first thing in it, which is
        // the close button and would sit here wearing a focus ring for as long
        // as the camera was open. The dialog still traps focus and still
        // closes on back or escape; there is simply nothing in here to type
        // into, which is also why the keyboard should not come up.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
      >
        <DialogHeader className="px-5 pb-4 pt-5 pr-12">
          <DialogTitle className="text-left text-xl">{title}</DialogTitle>
          <DialogDescription className="text-left text-base">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-square w-full overflow-hidden bg-black">
          <video
            ref={attach}
            className={cn(
              'size-full object-cover transition-opacity',
              status !== 'running' && 'opacity-0',
            )}
            playsInline
            muted
          />

          {status === 'running' && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-10 rounded-2xl border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
            />
          )}

          {status === 'starting' && (
            <div className="absolute inset-0 flex items-center justify-center text-white/80">
              <Loader2 aria-hidden="true" className="size-8 animate-spin" />
              <span className="sr-only">Starting the camera</span>
            </div>
          )}

          {status === 'error' && (
            <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-base text-white/80">
              {error}
            </p>
          )}

          {status === 'running' && torch && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-label={torchOn ? 'Turn the light off' : 'Turn the light on'}
              aria-pressed={torchOn}
              className="absolute bottom-4 right-4 flex size-12 items-center justify-center rounded-full bg-black/50 text-white outline-none backdrop-blur transition-colors hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white"
            >
              {torchOn ? (
                <FlashlightOff aria-hidden="true" className="size-6" />
              ) : (
                <Flashlight aria-hidden="true" className="size-6" />
              )}
            </button>
          )}
        </div>

        {refused && status === 'running' && (
          <p className="px-5 py-4 text-base text-foreground/55">{mismatch}</p>
        )}
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
