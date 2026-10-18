import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Where a computer login has got to. */
export type NearbyLoginStatus =
  | { state: 'scanning' }
  | { state: 'connecting' }
  | { state: 'comparing'; code: string; computer: string }
  | { state: 'sending' };

/**
 * Log a computer running Din in as an account on this phone, over Bluetooth.
 *
 * The key goes from the app process to the radio and never through here: this
 * layer starts the search and draws the progress, and the app process asks the
 * user — with the system's own prompt — before anything is sent. See
 * `NearbyLogin.java`.
 */
export interface NearbyLoginPlugin {
  /**
   * Find a computer waiting for a login and, once the user approves, send it
   * the key of `pubkey`. Rejects with code `CANCELED` if the user said no.
   */
  start(options: { pubkey: string }): Promise<{ computer: string }>;

  /** Stop looking, or take back an unanswered prompt. */
  cancel(): Promise<void>;

  addListener(
    event: 'status',
    listener: (status: NearbyLoginStatus) => void,
  ): Promise<PluginListenerHandle>;
}

export const NearbyLogin = registerPlugin<NearbyLoginPlugin>('NearbyLogin');

/** Whether this build can do it at all: the Android app. */
export function supportsNearbyLogin(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NearbyLogin');
}
