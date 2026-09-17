/**
 * The Shape Detection API's `BarcodeDetector`, and the camera torch.
 *
 * Both are Chromium-only and neither is in TypeScript's DOM lib, so they are
 * declared here rather than reached for through `any`. See `QrScannerDialog`,
 * which is the only thing that uses them — and which checks for the detector
 * at runtime before offering to scan anything, because on WebKit this whole
 * file describes something that isn't there.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector
 */

type BarcodeFormat =
  | 'aztec'
  | 'code_128'
  | 'code_39'
  | 'code_93'
  | 'codabar'
  | 'data_matrix'
  | 'ean_13'
  | 'ean_8'
  | 'itf'
  | 'pdf417'
  | 'qr_code'
  | 'upc_a'
  | 'upc_e'
  | 'unknown';

interface DetectedBarcode {
  readonly boundingBox: DOMRectReadOnly;
  readonly cornerPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly format: BarcodeFormat;
  readonly rawValue: string;
}

interface BarcodeDetectorOptions {
  formats?: BarcodeFormat[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  static getSupportedFormats(): Promise<BarcodeFormat[]>;
  detect(source: ImageBitmapSource | HTMLVideoElement): Promise<DetectedBarcode[]>;
}

/** The lamp beside the camera, which only some devices expose to the web. */
interface MediaTrackCapabilities {
  torch?: boolean;
}

interface MediaTrackConstraintSet {
  torch?: ConstrainBoolean;
}
