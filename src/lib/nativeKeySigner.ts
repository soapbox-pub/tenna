import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, NostrSigner } from '@nostrify/types';
import { getEventHash } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

import { TennaSigner } from '@/lib/tennaSignerPlugin';

/**
 * A signer for a key this process does not have.
 *
 * The key is in the app process, sealed on disk under the Android Keystore and
 * unsealed only in Java memory — `TennaKeys.java` has the long version. What
 * reaches here is a pubkey to name the account by, and every operation is a
 * bridge call that returns the answer rather than the means to compute it.
 *
 * Tenna is a browser for other people's sites, and the renderer it runs in is
 * the process that parses their bytes. An nsec in this heap could be read by
 * anything that got in and kept forever; the account would be gone, with no
 * password to reset. With the key on the other side of the bridge, the same
 * intruder gets to sign and decrypt as the user for as long as they are
 * resident, and nothing after that. That is the trade, and it is the same one
 * the NIP-55 path in `androidNativeSigner.ts` makes — this is that shape
 * without needing another app installed to make it.
 *
 * What it is *not* is a consent gate. Nothing here prompts. The prompts a site
 * goes through live in `useNsiteSignerRpc`, on this side of the bridge, and a
 * caller that has already got this far is one Tenna's own web layer decided to
 * trust. Moving the key changes who can steal it, not who can ask.
 */
export class NativeKeySigner implements NostrSigner {
  readonly pubkey: string;

  readonly nip04: NonNullable<NostrSigner['nip04']>;
  readonly nip44: NonNullable<NostrSigner['nip44']>;

  constructor(pubkey: string) {
    this.pubkey = pubkey;

    this.nip04 = {
      encrypt: (peer, plaintext) => this.encrypt('nip04', peer, plaintext),
      decrypt: (peer, ciphertext) => this.decrypt('nip04', peer, ciphertext),
    };
    this.nip44 = {
      encrypt: (peer, plaintext) => this.encrypt('nip44', peer, plaintext),
      decrypt: (peer, ciphertext) => this.decrypt('nip44', peer, ciphertext),
    };
  }

  /**
   * Known from the login, so this costs nothing and never fails.
   *
   * Which matters for the same reason it does under NIP-55: a relay can send
   * an AUTH challenge unprompted, and the answer has to be immediate.
   */
  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(template: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    const { event } = await TennaSigner.signEvent({
      pubkey: this.pubkey,
      event: JSON.stringify({
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: template.created_at,
      }),
    });

    const signed = JSON.parse(event) as NostrEvent;

    // Two implementations of the NIP-01 serialization now exist in this app,
    // one in Java and one here, and they agree or they don't. If they don't,
    // the signature is over an event nobody asked for: valid, publishable,
    // and absent from every relay that checks the id. Nothing else in the
    // system would report that, so this does.
    //
    // The signature itself is not re-verified. It came from our own process,
    // not from a signer app that might be lying, and a schnorr verify on
    // every sign would be paid for nothing.
    if (signed.id !== getEventHash(signed)) {
      throw new Error('The native signer and this one disagree about the event id');
    }
    if (signed.pubkey !== this.pubkey) {
      throw new Error('The native signer answered for the wrong account');
    }

    return signed;
  }

  private async encrypt(nip: 'nip04' | 'nip44', peer: string, plaintext: string): Promise<string> {
    const options = { pubkey: this.pubkey, peer, plaintext };
    const { result } = nip === 'nip44'
      ? await TennaSigner.nip44Encrypt(options)
      : await TennaSigner.nip04Encrypt(options);
    return result;
  }

  private async decrypt(nip: 'nip04' | 'nip44', peer: string, ciphertext: string): Promise<string> {
    const options = { pubkey: this.pubkey, peer, ciphertext };
    const { result } = nip === 'nip44'
      ? await TennaSigner.nip44Decrypt(options)
      : await TennaSigner.nip04Decrypt(options);
    return result;
  }
}

/**
 * Hand a key over to the native store and get back whose it is.
 *
 * Takes an `nsec1…`. Throws if the device has no native signer, so callers
 * check {@link supportsNativeSigner} first and keep the old path for when it
 * says no.
 */
export async function importNativeKey(nsec: string): Promise<string> {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error('Not an nsec');

  const { pubkey } = await TennaSigner.importKey({ secretKey: bytesToHex(decoded.data) });
  return pubkey;
}

/**
 * Make a new account natively.
 *
 * The nsec comes back so the signup screen can show it and write it to a file
 * — a user who cannot copy their key down does not have an account they can
 * take anywhere else. It exists in this process for as long as that screen is
 * open and is never readable again afterwards.
 */
export async function generateNativeKey(): Promise<{ pubkey: string; nsec: `nsec1${string}` }> {
  const { pubkey, secretKey } = await TennaSigner.generate();
  const bytes = Uint8Array.from(
    secretKey.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [],
  );

  if (bytes.length !== 32) throw new Error('The native signer returned a malformed key');

  return { pubkey, nsec: nip19.nsecEncode(bytes) };
}
