// Generates the vectors in NostrCryptoTest / NostrCipherTest with the exact
// libraries Tenna's web layer uses, which is the whole point of them: a native
// signer that disagrees with nostr-tools about any of this produces signatures
// over events no relay will agree exist.
//
// Run from the repo root, where node can resolve the app's own dependencies:
//   node android/app/src/test/genvec.mjs
import { schnorr } from '@noble/curves/secp256k1.js';
import { getPublicKey, getEventHash } from 'nostr-tools/pure';
import { nip04, nip44 } from 'nostr-tools';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));

const SK_A = unhex('0101010101010101010101010101010101010101010101010101010101010101');
const SK_B = unhex('0202020202020202020202020202020202020202020202020202020202020202');
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);

console.log('PK_A =', PK_A);
console.log('PK_B =', PK_B);

// NIP-44 conversation key (symmetric).
const conv = nip44.v2.utils.getConversationKey(SK_A, PK_B);
const convBA = nip44.v2.utils.getConversationKey(SK_B, PK_A);
console.log('conv    =', hex(conv));
console.log('conv BA =', hex(convBA), hex(conv) === hex(convBA) ? '(symmetric)' : '(MISMATCH)');

// Canonical event id, exercising the JSON.stringify escaping.
const tmpl = {
  pubkey: PK_A,
  created_at: 1752969600,
  kind: 22242,
  tags: [
    ['relay', 'wss://relay.example.com/'],
    ['challenge', 'abc"def\\g\nh\u0001i\u20ac\u{1F600}'],
  ],
  content: 'ctrl:\u0000\u001f tail',
};
const id = getEventHash(tmpl);
console.log('event id =', id);

// BIP-340 with a fixed aux, so the signature is reproducible.
const aux = unhex('aa'.repeat(32));
console.log('sig =', hex(schnorr.sign(unhex(id), SK_A, aux)));

// NIP-44 v2 payload with a fixed nonce.
const nonce = unhex('0f0e0d0c0b0a09080706050403020100ff00ff00ff00ff00ff00ff00ff00ff00');
const plaintext = 'hello, t\u00e4nna \u2713 "quotes" \\slash\n';
const payload = nip44.v2.encrypt(plaintext, conv, nonce);
console.log('nip44 plaintext =', JSON.stringify(plaintext));
console.log('nip44 payload b64 =', payload);
console.log('nip44 payload hex =', hex(Buffer.from(payload, 'base64')));

// NIP-04: the shared secret, and a payload for the native side to open. The IV
// is random per run, so the ct and iv below are only a vector as a pair —
// copy both or neither.
const nip04Payload = await nip04.encrypt(hex(SK_A), PK_B, plaintext);
const [ctB64, ivB64] = nip04Payload.split('?iv=');
console.log('nip04 ct hex =', hex(Buffer.from(ctB64, 'base64')));
console.log('nip04 iv hex =', hex(Buffer.from(ivB64, 'base64')));
console.log('nip04 roundtrip =', JSON.stringify(await nip04.decrypt(hex(SK_B), PK_A, nip04Payload)));

// The raw ECDH x-coordinate NIP-04 uses as its AES key, as nostr-tools derives it.
const { secp256k1 } = await import('@noble/curves/secp256k1.js');
console.log('nip04 shared =', hex(secp256k1.getSharedSecret(SK_A, unhex('02' + PK_B)).subarray(1, 33)));
