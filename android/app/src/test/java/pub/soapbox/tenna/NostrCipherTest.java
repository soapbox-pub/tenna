package pub.soapbox.tenna;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The encryption NIPs, against payloads written by nostr-tools.
 *
 * <p>These go through the {@code *Bytes} entry points rather than the string
 * ones, because the string ones frame in {@code android.util.Base64}, which is
 * a stub that returns zero in a JVM unit test. Base64 is not the part worth
 * pinning; what happens under it is.
 *
 * <p>Regenerate with {@code node android/app/src/test/genvec.mjs}.
 *
 * <p>Both directions are here on purpose. Encryption failing loudly is a bug;
 * decryption failing quietly is a message the user never sees and never knows
 * they were sent.
 */
public class NostrCipherTest {

    /** The NIP-44 conversation key between the test keys — see NostrCryptoTest. */
    private static final byte[] CONV = NostrCipher.hexToBytes(
            "59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5");

    /** The bare ECDH x between the same two, which is NIP-04's AES key. */
    private static final byte[] SHARED = NostrCipher.hexToBytes(
            "d0158a38faf6118af133af12d9bfa388eab4a08d1a2088ea6e6ec1269e03567f");

    private static final byte[] NONCE = NostrCipher.hexToBytes(
            "0f0e0d0c0b0a09080706050403020100ff00ff00ff00ff00ff00ff00ff00ff00");

    /** Quotes, a backslash, a newline, an umlaut and a check mark. */
    private static final String PLAINTEXT = "hello, tänna ✓ \"quotes\" \\slash\n";

    /** nip44.v2.encrypt(PLAINTEXT, CONV, NONCE), byte for byte. */
    private static final byte[] NIP44_PAYLOAD = NostrCipher.hexToBytes(
            "020f0e0d0c0b0a09080706050403020100ff00ff00ff00ff00ff00ff00ff00ff00"
                    + "84bf1db9a57aaf8779fde2da940407ffea3dbde6b6473d87af25636085ba31ea"
                    + "d867b9b462ce26d18dc776f24dd3416b63633d5500a1b68cf2665a9f7cfd1b89"
                    + "49d49a902e505038f7bb427fa3635e73f7ff5a0994194450fe9416a9c047ca9e"
                    + "6fd0");

    // ── NIP-44 v2 ────────────────────────────────────────────────────────────

    @Test
    public void nip44EncryptMatchesNostrTools() {
        assertArrayEquals(NIP44_PAYLOAD, NostrCipher.encrypt44Bytes(CONV, PLAINTEXT, NONCE));
    }

    @Test
    public void nip44DecryptsWhatNostrToolsWrote() {
        assertEquals(PLAINTEXT, NostrCipher.decrypt44Bytes(CONV, NIP44_PAYLOAD));
    }

    @Test
    public void nip44RejectsATamperedPayload() {
        // A flipped bit in the ciphertext: the MAC must catch it, and the
        // answer must be null rather than garbage or an exception.
        byte[] tampered = NIP44_PAYLOAD.clone();
        tampered[40] ^= 0x01;
        assertNull(NostrCipher.decrypt44Bytes(CONV, tampered));

        // A flipped bit in the MAC itself.
        byte[] badMac = NIP44_PAYLOAD.clone();
        badMac[badMac.length - 1] ^= 0x01;
        assertNull(NostrCipher.decrypt44Bytes(CONV, badMac));

        // The right payload under the wrong key.
        byte[] wrongKey = CONV.clone();
        wrongKey[0] ^= 0x01;
        assertNull(NostrCipher.decrypt44Bytes(wrongKey, NIP44_PAYLOAD));
    }

    @Test
    public void nip44RejectsMalformedInput() {
        assertNull(NostrCipher.decrypt44Bytes(CONV, null));
        assertNull(NostrCipher.decrypt44Bytes(CONV, new byte[0]));
        assertNull(NostrCipher.decrypt44Bytes(CONV, new byte[98]));
        assertNull(NostrCipher.decrypt44Bytes(new byte[31], NIP44_PAYLOAD));

        // Version 1 is a different scheme and is not implemented; it must be
        // refused rather than read as if it were v2.
        byte[] v1 = NIP44_PAYLOAD.clone();
        v1[0] = 1;
        assertNull(NostrCipher.decrypt44Bytes(CONV, v1));
    }

    @Test
    public void nip44PaddingHidesLength() {
        // Everything up to 32 bytes encrypts to the same size, which is the
        // point of the padding scheme.
        int shortest = NostrCipher.encrypt44Bytes(CONV, "a", NONCE).length;
        int longer = NostrCipher.encrypt44Bytes(CONV, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", NONCE).length;
        assertEquals(shortest, longer);

        // And a round trip survives the boundary either side of 32.
        for (int n : new int[] { 1, 31, 32, 33, 100, 1000 }) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n; i++) sb.append('x');
            String text = sb.toString();
            assertEquals(text, NostrCipher.decrypt44Bytes(
                    CONV, NostrCipher.encrypt44Bytes(CONV, text, NONCE)));
        }
    }

    @Test
    public void nip44LongMessagesMatchTheSpecVectors() throws Exception {
        // encrypt_decrypt_long_msg from the NIP-44 vectors: the largest a u16
        // prefix can carry, in one-, one- and four-byte characters.
        assertLongVector("8fc262099ce0d0bb9b89bac05bb9e04f9bc0090acc181fef6840ccee470371ed",
                "326bcb2c943cd6bb717588c9e5a7e738edf6ed14ec5f5344caa6ef56f0b9cff7",
                "x", 65535,
                "90714492225faba06310bff2f249ebdc2a5e609d65a629f1c87f2d4ffc55330a");
        assertLongVector("56adbe3720339363ab9c3b8526ffce9fd77600927488bfc4b59f7a68ffe5eae0",
                "ad68da81833c2a8ff609c3d2c0335fd44fe5954f85bb580c6a8d467aa9fc5dd0",
                "!", 65535,
                "8013e45a109fad3362133132b460a2d5bce235fe71c8b8f4014793fb52a49844");
        assertLongVector("7fc540779979e472bb8d12480b443d1e5eb1098eae546ef2390bee499bbf46be",
                "34905e82105c20de9a2f6cd385a0d541e6bcc10601d12481ff3a7575dc622033",
                "\uD83E\uDD84", 16383,
                "b3348422471da1f3c59d79acfe2fe103f3cd24488109e5b18734cdb5953afd15");
    }

    @Test
    public void nip44ExtendedPrefixMatchesNostrTools() throws Exception {
        // From 65536 bytes up the prefix is [0x0000][u32-BE len]. A bunker
        // that cannot write it cannot hand back a large signed event at all.
        String conv = "59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5";
        String nonce = "0f0e0d0c0b0a09080706050403020100ff00ff00ff00ff00ff00ff00ff00ff00";
        assertLongVector(conv, nonce, "x", 65535,
                "27962dfc53d533b5e119563ce1a1d403eff5440a6d6e031f464f55d4ec64d636");
        assertLongVector(conv, nonce, "x", 65536,
                "b839d1e7ae7512c25bd18930bfc6d0db23f32506f0c3e27e83db7475ef60dd27");
        assertLongVector(conv, nonce, "x", 65537,
                "5057b5795d43f3f8f0d01d9f126888a4321809a43f930d958d9dacb274274877");
        assertLongVector(conv, nonce, "x", 100000,
                "1eb17a366cdc4b2f908dd1ff186940df62f86b8bbcfddc24914763c6eef07a66");
    }

    @Test
    public void nip44RejectsNonCanonicalPadding() throws Exception {
        // Each of these carries a valid MAC, so only the padding check stands
        // between it and being read.
        byte[] ok = new byte[2 + 32];
        ok[1] = 1;
        ok[2] = 'a';
        assertEquals("a", NostrCipher.decrypt44Bytes(CONV, seal(ok)));

        // The right length prefix with a padded length that is not the one
        // that length calls for.
        byte[] extraPadding = new byte[2 + 64];
        extraPadding[1] = 1;
        extraPadding[2] = 'a';
        assertNull(NostrCipher.decrypt44Bytes(CONV, seal(extraPadding)));

        // A length that runs past the end.
        byte[] overrun = new byte[2 + 32];
        overrun[1] = 33;
        assertNull(NostrCipher.decrypt44Bytes(CONV, seal(overrun)));

        // The extended prefix for a length the short one could have carried.
        byte[] needlessExtended = new byte[6 + 32];
        needlessExtended[5] = 1;
        needlessExtended[6] = 'a';
        assertNull(NostrCipher.decrypt44Bytes(CONV, seal(needlessExtended)));
        byte[] justUnder = new byte[6 + 65536];
        justUnder[4] = (byte) 0xff;
        justUnder[5] = (byte) 0xff;
        assertNull(NostrCipher.decrypt44Bytes(CONV, seal(justUnder)));

        // The extended prefix done right is read.
        byte[] extended = new byte[6 + 65536];
        extended[3] = 1;
        java.util.Arrays.fill(extended, 6, extended.length, (byte) 'y');
        assertEquals(65536, NostrCipher.decrypt44Bytes(CONV, seal(extended)).length());

        // And with its padding cut short.
        assertNull(NostrCipher.decrypt44Bytes(CONV,
                seal(java.util.Arrays.copyOf(extended, extended.length - 32))));
    }

    private static void assertLongVector(String conv, String nonce, String pattern, int repeat,
            String payloadSha256) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < repeat; i++) sb.append(pattern);
        String plaintext = sb.toString();
        byte[] key = NostrCipher.hexToBytes(conv);

        byte[] payload = NostrCipher.encrypt44Bytes(key, plaintext, NostrCipher.hexToBytes(nonce));
        // The vectors hash the base64 text, not the bytes under it.
        byte[] b64 = java.util.Base64.getEncoder().encode(payload);
        assertEquals(payloadSha256, hex(MessageDigest.getInstance("SHA-256").digest(b64)));
        assertEquals(plaintext, NostrCipher.decrypt44Bytes(key, payload));
    }

    /** Encrypt and MAC an arbitrary padded buffer, the way a hostile peer could. */
    private static byte[] seal(byte[] padded) throws Exception {
        // HKDF-expand(CONV, NONCE, 76), which is three HMAC blocks.
        byte[] keys = new byte[96];
        byte[] t = new byte[0];
        for (int i = 1; i <= 3; i++) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(CONV, "HmacSHA256"));
            mac.update(t);
            mac.update(NONCE);
            mac.update((byte) i);
            t = mac.doFinal();
            System.arraycopy(t, 0, keys, (i - 1) * 32, 32);
        }
        byte[] ciphertext = NostrCipher.chacha20(
                java.util.Arrays.copyOfRange(keys, 0, 32),
                java.util.Arrays.copyOfRange(keys, 32, 44), padded);

        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(java.util.Arrays.copyOfRange(keys, 44, 76), "HmacSHA256"));
        mac.update(NONCE);
        byte[] tag = mac.doFinal(ciphertext);

        byte[] out = new byte[1 + 32 + ciphertext.length + 32];
        out[0] = 2;
        System.arraycopy(NONCE, 0, out, 1, 32);
        System.arraycopy(ciphertext, 0, out, 33, ciphertext.length);
        System.arraycopy(tag, 0, out, 33 + ciphertext.length, 32);
        return out;
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    // ── NIP-04 ───────────────────────────────────────────────────────────────

    @Test
    public void nip04DecryptsWhatNostrToolsWrote() {
        byte[] ciphertext = NostrCipher.hexToBytes(
                "eb59180fe6f4b550d01889463c7b1a73c4ea1ca4f7426f6bd55db7e77113df47"
                        + "e45422465ce93c6b2c248137b95097e0");
        byte[] iv = NostrCipher.hexToBytes("e02de5b0ce36ffc3c19686ca674c93f8");
        assertEquals(PLAINTEXT, NostrCipher.decrypt04Bytes(SHARED, ciphertext, iv));
    }

    @Test
    public void nip04RoundTrips() {
        byte[] iv = NostrCipher.hexToBytes("000102030405060708090a0b0c0d0e0f");
        byte[] ciphertext = NostrCipher.encrypt04Bytes(SHARED, PLAINTEXT, iv);
        assertEquals(PLAINTEXT, NostrCipher.decrypt04Bytes(SHARED, ciphertext, iv));
    }

    @Test
    public void nip04RejectsMalformedInput() {
        byte[] iv = NostrCipher.hexToBytes("000102030405060708090a0b0c0d0e0f");
        assertNull(NostrCipher.encrypt04Bytes(SHARED, PLAINTEXT, new byte[8]));
        assertNull(NostrCipher.encrypt04Bytes(new byte[16], PLAINTEXT, iv));
        assertNull(NostrCipher.decrypt04Bytes(SHARED, new byte[] { 1, 2, 3 }, iv));
        assertNull(NostrCipher.decrypt04Bytes(SHARED, null, iv));
    }

    // ── Hex ──────────────────────────────────────────────────────────────────

    @Test
    public void hexRefusesWhatIsNotHex() {
        assertNull(NostrCipher.hexToBytes(null));
        assertNull(NostrCipher.hexToBytes("abc"));
        assertNull(NostrCipher.hexToBytes("zz"));
        assertEquals(0, NostrCipher.hexToBytes("").length);
    }
}
