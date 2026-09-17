import { useEffect, useState } from 'react';

/**
 * Whether this device can read a QR code out of its camera.
 *
 * Two things have to be true: a camera the web layer may open, and the
 * platform's own barcode reader. Tenna scans with `BarcodeDetector` — the one
 * decoder that is already on the device — rather than shipping a decoder of
 * its own, because a JavaScript one has to run either in a worker or on the
 * main thread, and this app's CSP allows no workers at all. Chromium has the
 * API and WebKit does not, which in practice means Android yes, iOS no.
 *
 * It is asked before anything is offered, so a device that cannot scan is
 * never shown a camera button that would only fail when pressed. The answer
 * starts as no and turns to yes once the formats come back; the check costs
 * nothing and settles in the same tick the dialog opens in.
 */
export function useQrScanning(): boolean {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (typeof BarcodeDetector === 'undefined') return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;

    BarcodeDetector.getSupportedFormats()
      .then((formats) => {
        if (!cancelled) setSupported(formats.includes('qr_code'));
      })
      .catch(() => {
        // A detector that cannot say what it reads is one we don't use.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return supported;
}
