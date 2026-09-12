package pub.soapbox.tenna;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

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
