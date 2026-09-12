import { Capacitor, registerPlugin } from '@capacitor/core';

/** What an application is asking for, as the sheet needs to draw it. */
export interface SignerRequest {
  /** Echoed back when the request is answered. */
  id: string;
  /** The NIP-55 method name, for the record. */
  method: string;
  /** What a grant for this would be recorded under, if it takes one. */
  permission: string | null;
  /** What the caller is called. */
  appName: string;
  /** `package`, `web`, or `bunker`. */
  appKind: string;
  /** The calling package, or null for a web page with nothing behind it. */
  requesterId: string | null;
  /** The caller's launcher icon, as a data URL. */
  icon: string | null;
  /** The account that would answer, or null if this device holds no key. */
  account: string | null;
  /** What that account is called. */
  accountName?: string;
  /** The other party, for encryption and decryption. */
  peer: string | null;
  /** The kind of event, when one is being signed. */
  kind?: number;
  /** The event, as JSON text exactly as it arrived. */
  event?: string;
  /** Whether "remember this" is worth offering — see `TennaSigning.decide`. */
  canRemember: boolean;
  /** Whether there is an account here that could answer at all. */
  signedIn: boolean;
  /**
   * Somebody is signed in, but their key lives somewhere else — an extension,
   * a remote signer, or another signer app on the phone. A different "no" from
   * nobody being signed in, and one that signing in again would not fix.
   */
  signedInElsewhere: boolean;
}

/**
 * The wire between the approval sheet and the activity that raised it.
 *
 * Only registered by `SignerActivity`, and only when there is something to
 * ask — a request the user has already decided about is answered natively with
 * no WebView loaded at all, so this plugin is absent on every screen except
 * the sheet.
 */
export interface SignerPromptPlugin {
  /** What is being asked, or `{}` when nothing is. */
  getPending(): Promise<Partial<SignerRequest>>;

  /** What the user pressed. */
  resolve(options: { id: string; allowed: boolean; remember?: boolean }): Promise<void>;

  /** Close without answering. Every dismissal is a no. */
  dismiss(): Promise<void>;

  /** A second request arrived while the sheet was up. */
  addListener(
    event: 'signerRequest',
    listener: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const SignerPrompt = registerPlugin<SignerPromptPlugin>('SignerPrompt');

/** Whether this window is one an application's request was routed into. */
export function supportsSignerPrompt(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('SignerPrompt');
}
