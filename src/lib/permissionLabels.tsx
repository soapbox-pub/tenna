import { Bell, Camera, KeyRound, Link2, Lock, MapPin, Mic, Pen, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { getKindLabel } from '@/lib/kindLabels';

/**
 * Everything Tenna asks permission for, whoever is asking.
 *
 * A site in a window, an app on the phone, and a client on the other end of a
 * relay ask the same questions about the same key, so they get the same
 * vocabulary and the same sheet. The last three are the ones only an
 * application can ask; the three device permissions are ones only a site can.
 */
export type PermissionKind =
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt'
  | 'push'
  | 'camera'
  | 'microphone'
  | 'location'
  | 'getPublicKey'
  | 'decryptZapEvent'
  | 'connect';

export function permissionIcon(type: PermissionKind): ReactNode {
  switch (type) {
    case 'signEvent':
      return <Pen className="size-5 text-amber-500" />;
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return <Lock className="size-5 text-blue-500" />;
    case 'nip04.decrypt':
    case 'nip44.decrypt':
    case 'decryptZapEvent':
      return <KeyRound className="size-5 text-violet-500" />;
    case 'push':
      return <Bell className="size-5 text-emerald-500" />;
    case 'camera':
      return <Camera className="size-5 text-rose-500" />;
    case 'microphone':
      return <Mic className="size-5 text-rose-500" />;
    case 'location':
      return <MapPin className="size-5 text-rose-500" />;
    case 'getPublicKey':
      return <UserRound className="size-5 text-sky-500" />;
    case 'connect':
      return <Link2 className="size-5 text-emerald-500" />;
  }
}

export function permissionTitle(type: PermissionKind, kind: number | null): string {
  switch (type) {
    case 'signEvent':
      return kind !== null ? `Sign: ${getKindLabel(kind)}` : 'Sign event';
    case 'nip04.encrypt':
      return 'Encrypt message (NIP-04)';
    case 'nip04.decrypt':
      return 'Decrypt message (NIP-04)';
    case 'nip44.encrypt':
      return 'Encrypt message (NIP-44)';
    case 'nip44.decrypt':
      return 'Decrypt message (NIP-44)';
    case 'push':
      return 'Send notifications';
    case 'camera':
      return 'Use the camera';
    case 'microphone':
      return 'Use the microphone';
    case 'location':
      return 'Use your location';
    case 'getPublicKey':
      return 'See who you are';
    case 'decryptZapEvent':
      return 'Read a private zap';
    case 'connect':
      return 'Use your account';
  }
}

export function permissionDescription(type: PermissionKind): string {
  switch (type) {
    case 'signEvent':
      return 'This app wants to sign a Nostr event on your behalf.';
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return 'This app wants to encrypt a message using your keys.';
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return 'This app wants to decrypt a message using your keys.';
    case 'push':
      return 'This app wants Tenna to watch relays for it and notify you of new events, even while it is closed.';
    case 'camera':
      return 'This app wants to see through your camera while you are using it.';
    case 'microphone':
      return 'This app wants to hear through your microphone while you are using it.';
    case 'location':
      return 'This app wants to know where you are while you are using it.';
    case 'getPublicKey':
      return 'This app wants to know which account you are signed in as. It cannot sign anything with the answer.';
    case 'decryptZapEvent':
      return 'This app wants to read a private zap sent to you.';
    case 'connect':
      return 'This app wants to sign and encrypt with your key from wherever it is running, until you take it back.';
  }
}
