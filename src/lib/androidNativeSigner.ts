import type { NostrEvent, NostrSigner } from '@nostrify/types';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { NostrSignerPlugin } from 'capacitor-plugin-nostr-signer';

/**
 * NIP-55: a signer that lives in another app on the device.
 *
 * The key never enters this process. Every operation is an Android intent to
 * the signer app — Amber and the like — which prompts the user, does the
 * crypto, and hands back the result. That makes each call a round trip
 * through another activity, so it is slow by nature and can be refused.
 *
 * The pubkey is cached after the first `getPublicKey()`, and a persisted
 * login seeds it through the constructor, so relaunching the app doesn't
 * prompt the signer just to learn who the user is.
 */
export class AndroidNativeSigner implements NostrSigner {
  readonly packageName: string;

  private pubkey: string | null;
  private connected = false;

  readonly nip04: NonNullable<NostrSigner['nip04']>;
  readonly nip44: NonNullable<NostrSigner['nip44']>;

  constructor(packageName: string, pubkey?: string) {
    this.packageName = packageName;
    this.pubkey = pubkey ?? null;

    this.nip04 = {
      encrypt: this.nip04Encrypt.bind(this),
      decrypt: this.nip04Decrypt.bind(this),
    };
    this.nip44 = {
      encrypt: this.nip44Encrypt.bind(this),
      decrypt: this.nip44Decrypt.bind(this),
    };
  }

  /** The signer apps installed on this device. Throws if the platform has none. */
  static async getSignerApps() {
    const { apps } = await NostrSignerPlugin.getInstalledSignerApps();
    return apps;
  }

  /**
   * Bind the plugin to this signer's package, and learn the pubkey if we
   * don't have it yet. Only the first call touches the plugin.
   */
  private async setup(): Promise<string> {
    if (this.connected && this.pubkey) return this.pubkey;

    await NostrSignerPlugin.setPackageName(this.packageName);

    if (!this.pubkey) {
      const { pubkey } = await NostrSignerPlugin.getPublicKey();
      this.pubkey = pubkey;
    }

    this.connected = true;
    return this.pubkey;
  }

  async getPublicKey(): Promise<string> {
    return await this.setup();
  }

  async signEvent(template: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();

    // The signer wants a whole event, id included, with an empty signature
    // where the one it is about to make will go.
    const withPubkey = { ...template, pubkey } as Omit<NostrEvent, 'id' | 'sig'>;
    const id = getEventHash(withPubkey);
    const eventJson = JSON.stringify({ ...withPubkey, id, sig: '' });

    const result = await NostrSignerPlugin.signEvent(
      this.packageName,
      eventJson,
      id,
      pubkey,
    );

    // Another app on the device answered this, and nothing but the signature
    // itself says it is the app we asked. Verify before handing it on.
    const signed = JSON.parse(result.event) as NostrEvent;
    if (!verifyEvent(signed)) {
      throw new Error('Android signer returned an invalid signature');
    }
    return signed;
  }

  // Each crypto call carries a request id, which the signer echoes back so
  // that concurrent requests can be told apart. A fresh UUID per call.

  private async nip04Encrypt(pubkey: string, plaintext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip04Encrypt(
      this.packageName,
      plaintext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip04Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip04Decrypt(
      this.packageName,
      ciphertext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip44Encrypt(
      this.packageName,
      plaintext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip44Decrypt(
      this.packageName,
      ciphertext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }
}
