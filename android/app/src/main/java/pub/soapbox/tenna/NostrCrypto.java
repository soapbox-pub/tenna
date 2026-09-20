package pub.soapbox.tenna;

import fr.acinq.secp256k1.Secp256k1;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The secp256k1 side of Nostr: x-only public keys, BIP-340 Schnorr signatures,
 * canonical NIP-01 event ids, and the two shared secrets the encryption NIPs
 * are built on.
 *
 * <p>None of the curve arithmetic is ours. It delegates to ACINQ's
 * {@link Secp256k1} bindings over libsecp256k1, the audited C library Bitcoin
 * Core uses — as do Amber and Amethyst, through the same bindings. What is
 * ours is the plumbing around it: which bytes go in, and the NIP-01
 * serialization whose hash comes out.
 *
 * <p>That plumbing is where a signer goes wrong silently. An event id that
 * disagrees with the one nostr-tools would compute is still a valid signature
 * over something, just not over the event anybody will read. So the vectors in
 * {@code NostrCryptoTest} were generated with the exact libraries the web
 * layer uses, and {@code NativeKeySigner} re-derives the id in JavaScript and
 * refuses anything that doesn't match.
 *
 * <p>Ported from Armada's class of the same name, which has carried the
 * background notification service since 2026.
 */
final class NostrCrypto {

    private NostrCrypto() {}

    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * The JNI library, loaded on first use rather than at class init.
     *
     * <p>A release APK may be built for a subset of ABIs (see {@code apkAbis}
     * in {@code build.gradle}), and a device outside that set must fail as
     * "this device has no native signer" — which the web layer answers by
     * keeping the key in JavaScript, as it always did — rather than by
     * throwing {@link ExceptionInInitializerError} out of an unrelated class.
     */
    private static Secp256k1 secp;
    private static boolean secpTried;

    private static synchronized Secp256k1 secp() {
        if (!secpTried) {
            secpTried = true;
            try {
                secp = Secp256k1.get();
            } catch (Throwable t) {
                secp = null;
            }
        }
        return secp;
    }

    /** Whether libsecp256k1 loaded on this device. Nothing else here works if it didn't. */
    static boolean isAvailable() {
        return secp() != null;
    }

    // ── Keys ─────────────────────────────────────────────────────────────────

    /** A fresh 32-byte secret key from the platform CSPRNG. */
    static byte[] generateSecretKey() {
        // Every 32-byte string but zero and the handful above the group order
        // is a valid key; the chance of drawing one of those is not worth a
        // retry loop, but it is worth the check, and secp tells us.
        Secp256k1 s = secp();
        byte[] sk = new byte[32];
        for (int i = 0; i < 8; i++) {
            RANDOM.nextBytes(sk);
            if (s == null || s.secKeyVerify(sk)) return sk;
        }
        throw new IllegalStateException("Could not draw a valid secret key");
    }

    /** x-only (BIP-340 / Nostr) public key for a 32-byte secret key, hex. */
    static String pubkeyOf(byte[] sk) {
        // pubkeyCreate → 65-byte uncompressed; compress → 33 bytes (prefix +
        // x); the x-only key drops the parity prefix.
        byte[] compressed = secp().pubKeyCompress(secp().pubkeyCreate(sk));
        byte[] xonly = new byte[32];
        System.arraycopy(compressed, 1, xonly, 0, 32);
        return bytesToHex(xonly);
    }

    /**
     * The x-coordinate of {@code sk · lift_x(peer)} — the shared secret both
     * encryption NIPs start from, and NIP-04's key as-is.
     *
     * <p>Deliberately not libsecp's {@code ecdh} helper, which returns a
     * SHA-256 of the point: both NIPs want the bare x. The even-Y lift (0x02
     * prefix) matches nostr-tools; a point and its negation share an x, so the
     * peer's true Y parity doesn't change the answer.
     *
     * <p>Returns null on any invalid input (bad hex, x not on the curve)
     * rather than throwing.
     */
    static byte[] sharedSecret(byte[] sk, String peerPkHex) {
        try {
            byte[] x = NostrCipher.hexToBytes(peerPkHex);
            if (x == null || x.length != 32) return null;
            byte[] compressed = new byte[33];
            compressed[0] = 0x02; // lift_x: the even-Y point
            System.arraycopy(x, 0, compressed, 1, 32);
            byte[] shared = secp().pubKeyTweakMul(compressed, sk);
            byte[] sharedX = new byte[32];
            System.arraycopy(shared, 1, sharedX, 0, 32);
            return sharedX;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * NIP-44 v2 conversation key between {@code sk} and an x-only peer pubkey:
     * {@code HKDF-Extract(salt="nip44-v2", ikm=sharedSecret)}. Symmetric —
     * conv(a, B) == conv(b, A). Null on any invalid input.
     */
    static byte[] conversationKey(byte[] sk, String peerPkHex) {
        try {
            byte[] sharedX = sharedSecret(sk, peerPkHex);
            if (sharedX == null) return null;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec("nip44-v2".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(sharedX);
        } catch (Exception e) {
            return null;
        }
    }

    // ── BIP-340 Schnorr ──────────────────────────────────────────────────────

    /** Sign a 32-byte message hash per BIP-340. {@code aux} is 32 random bytes. */
    static byte[] schnorrSign(byte[] msg32, byte[] sk, byte[] aux32) throws Exception {
        return secp().signSchnorr(msg32, sk, aux32);
    }

    /**
     * Verify a 64-byte BIP-340 Schnorr signature over {@code msg32} for the
     * x-only public key {@code pk32}. Returns false (never throws) on any
     * malformed input or a signature that doesn't check out.
     */
    static boolean schnorrVerify(byte[] msg32, byte[] pk32, byte[] sig64) {
        try {
            if (msg32 == null || msg32.length != 32) return false;
            if (pk32 == null || pk32.length != 32) return false;
            if (sig64 == null || sig64.length != 64) return false;
            return secp().verifySchnorr(sig64, msg32, pk32);
        } catch (Exception ex) {
            return false;
        }
    }

    // ── NIP-01 events ────────────────────────────────────────────────────────

    /**
     * The canonical NIP-01 event id: sha256 of
     * {@code [0,pubkey,created_at,kind,tags,content]} serialized exactly as
     * JavaScript's {@code JSON.stringify} would (see {@link #jsonString}) —
     * org.json's own serializer escapes differently and must not be used here.
     */
    static String eventId(String pubkey, long createdAt, int kind, JSONArray tags, String content) {
        StringBuilder sb = new StringBuilder();
        sb.append("[0,\"").append(pubkey).append("\",").append(createdAt).append(',').append(kind).append(',');
        sb.append('[');
        for (int i = 0; i < tags.length(); i++) {
            if (i > 0) sb.append(',');
            JSONArray tag = tags.optJSONArray(i);
            sb.append('[');
            if (tag != null) {
                for (int j = 0; j < tag.length(); j++) {
                    if (j > 0) sb.append(',');
                    jsonString(sb, tag.optString(j));
                }
            }
            sb.append(']');
        }
        sb.append("],");
        jsonString(sb, content);
        sb.append(']');
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return bytesToHex(sha.digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e); // SHA-256 always exists
        }
    }

    /** Build, id and Schnorr-sign a complete event with the given secret key. */
    static JSONObject finalizeEvent(int kind, String content, JSONArray tags, long createdAt, byte[] sk)
            throws Exception {
        String pubkey = pubkeyOf(sk);
        String id = eventId(pubkey, createdAt, kind, tags, content);
        byte[] aux = new byte[32];
        RANDOM.nextBytes(aux);
        byte[] sig = schnorrSign(NostrCipher.hexToBytes(id), sk, aux);
        JSONObject ev = new JSONObject();
        ev.put("id", id);
        ev.put("pubkey", pubkey);
        ev.put("created_at", createdAt);
        ev.put("kind", kind);
        ev.put("tags", tags);
        ev.put("content", content);
        ev.put("sig", bytesToHex(sig));
        return ev;
    }

    /**
     * Whether a whole event is its own: the id is the hash of its contents,
     * and the signature is that id signed by the pubkey it names.
     *
     * <p>This is the only thing standing between a relay and a lie. A relay is
     * somebody else's server, and an unverified event is that server's opinion
     * about what a user said — so everything arriving on a socket goes through
     * here before anything else looks at it. Both halves matter: the signature
     * alone would let a relay keep a real event's {@code sig} and change its
     * {@code content}, and the id alone would let it write an event from
     * scratch under anybody's pubkey.
     *
     * <p>False, never an exception, for anything malformed — a missing field,
     * hex that isn't hex, a pubkey of the wrong length. Also false, for
     * everything, on a device where libsecp256k1 did not load: nothing here can
     * check a signature then, and an event that cannot be checked is not one we
     * will act on. Callers that care about the difference ask
     * {@link #isAvailable()}.
     */
    static boolean verifyEvent(JSONObject event) {
        try {
            String pubkey = event.optString("pubkey", "");
            String id = event.optString("id", "");
            String sig = event.optString("sig", "");
            JSONArray tags = event.optJSONArray("tags");
            if (tags == null) tags = new JSONArray();

            String computed = eventId(
                pubkey, event.optLong("created_at", 0), event.optInt("kind", -1),
                tags, event.optString("content", ""));
            if (!computed.equals(id)) return false;

            return schnorrVerify(
                NostrCipher.hexToBytes(id),
                NostrCipher.hexToBytes(pubkey),
                NostrCipher.hexToBytes(sig));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Append a JSON string literal exactly as JavaScript's JSON.stringify:
     * escape {@code "} and {@code \}, use the two-char forms for
     * {@code \b \t \n \f \r}, {@code \\u00xx} for other control chars, and emit
     * everything else (including all non-ASCII) literally. org.json instead
     * escapes {@code /} after {@code <} and high code points, which would
     * change the hash.
     */
    private static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\f': sb.append("\\f"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }
}
