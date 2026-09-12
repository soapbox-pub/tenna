import { Capacitor, registerPlugin } from '@capacitor/core';

import type { PermissionKind } from '@/lib/permissionLabels';

/** One thing an application has been allowed, or refused. */
export interface SignerGrant {
  type: PermissionKind;
  /** The event kind, for `signEvent`; absent otherwise. */
  kind?: number;
  allowed: boolean;
}

/** An application this device has answered for. */
export interface SignerApp {
  /** The calling package, or the client's pubkey for a remote app. */
  requesterId: string;
  /** `package`, `bunker`, or `web`. */
  kind: string;
  name: string;
  createdAt: number;
  lastUsed: number;
  /** The launcher icon, as a data URL, when one was captured. */
  icon: string | null;
  permissions: SignerGrant[];
}

/** A standing invitation to an application somewhere else. */
export interface SignerConnection {
  /** The connection's own key — what the client talks to. */
  localPubkey: string;
  /** The client, once one has turned up. */
  clientPubkey: string;
  name: string;
  connected: boolean;
  /** The `bunker://` link that makes the connection. */
  uri: string;
  relays: string[];
  createdAt: number;
  lastUsed: number;
}

/**
 * Who has been given a key, for the screen that lists them.
 *
 * The grants themselves live on the native side, because the two paths that
 * answer without a WebView — a content resolver query and a relay socket —
 * have to be able to read them with no web layer running. This is the window
 * onto that, and the only things it writes are revocations.
 *
 * Lists cross as JSON text rather than as objects, for the reason everything
 * else in this app does: Capacitor's coercion does not keep an arbitrarily
 * shaped array intact.
 */
export interface SignerAppsPlugin {
  list(options: { account: string }): Promise<{ apps: string }>;
  revoke(options: {
    account: string;
    requesterId: string;
    type: string;
    kind?: number;
  }): Promise<void>;
  forget(options: { account: string; requesterId: string }): Promise<void>;

  listConnections(options: { account: string }): Promise<{ connections: string }>;
  createConnection(options: {
    account: string;
    relays: string[];
  }): Promise<{ uri: string; localPubkey: string }>;
  connect(options: {
    account: string;
    uri: string;
  }): Promise<{ name: string; localPubkey: string }>;
  revokeConnection(options: { localPubkey: string }): Promise<void>;
}

export const SignerApps = registerPlugin<SignerAppsPlugin>('SignerApps');

/** Whether this build can answer another application at all. */
export function supportsSignerApps(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('SignerApps');
}

/** The applications this account has answered for. */
export async function listSignerApps(account: string): Promise<SignerApp[]> {
  if (!supportsSignerApps()) return [];
  try {
    const { apps } = await SignerApps.list({ account });
    const parsed: unknown = JSON.parse(apps);
    return Array.isArray(parsed) ? (parsed as SignerApp[]) : [];
  } catch {
    // An older build of the app shell, or a store that could not be read.
    // An empty list is wrong in the safe direction: it shows nothing rather
    // than claiming nothing has been granted.
    return [];
  }
}

/** The standing invitations this account has out. */
export async function listSignerConnections(account: string): Promise<SignerConnection[]> {
  if (!supportsSignerApps()) return [];
  try {
    const { connections } = await SignerApps.listConnections({ account });
    const parsed: unknown = JSON.parse(connections);
    return Array.isArray(parsed) ? (parsed as SignerConnection[]) : [];
  } catch {
    return [];
  }
}
