package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * What the native signer produces has to be indistinguishable from what the
 * web layer used to produce with the same key, because for a while both will
 * be signing for the same accounts and nobody can tell from the outside which
 * did. So every expected value here was generated with the exact libraries the
 * web layer uses — nostr-tools and @noble/curves — from the inputs written
 * beside it.
 *
 * <p>Regenerate with {@code node android/app/src/test/genvec.mjs}.
 *
 * <p>The event id is the one that matters most. A signature over a subtly
 * different serialization is a valid signature over an event no relay will
 * agree exists, and nothing would report an error: the sign call succeeds, the
 * publish succeeds, and the note is simply never there. Hence the escaping zoo
 * in {@link #computesCanonicalEventId}.
 */
public class NostrCryptoTest {

    private static final byte[] SK_A = NostrCipher.hexToBytes(
            "0101010101010101010101010101010101010101010101010101010101010101");
    private static final byte[] SK_B = NostrCipher.hexToBytes(
            "0202020202020202020202020202020202020202020202020202020202020202");
    private static final String PK_A =
            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    private static final String PK_B =
            "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";

    private static final String VECTOR_SIG =
            "e77583081169970bfb181a6a26a09b93d97263e3ef1ef259d74c7e4381ea270a"
                    + "788e6a304905a99cc79af2c65b150cf1dcb7977b35dd44586332f9a1e722dfc3";
    private static final String VECTOR_ID =
            "e18a5afe0d88c618fd757dee0dd2cd12dcf82f88a6beff8edb27e3683ee8c893";
    private static final String VECTOR_CONTENT = "ctrl:\u0000\u001f tail";

    /** The tags the id and signature vectors are over. */
    private static JSONArray vectorTags() {
        return new JSONArray()
                .put(new JSONArray().put("relay").put("wss://relay.example.com/"))
                .put(new JSONArray().put("challenge").put("abc\"def\\g\nh\u0001i€😀"));
    }

    @Test
    public void libraryLoads() {
        assertTrue("libsecp256k1 did not load in the test JVM", NostrCrypto.isAvailable());
    }

    @Test
    public void derivesXOnlyPubkeys() {
        assertEquals(PK_A, NostrCrypto.pubkeyOf(SK_A));
        assertEquals(PK_B, NostrCrypto.pubkeyOf(SK_B));
    }

    @Test
    public void derivesSymmetricNip44ConversationKey() {
        String expected = "59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5";
        byte[] ab = NostrCrypto.conversationKey(SK_A, PK_B);
        byte[] ba = NostrCrypto.conversationKey(SK_B, PK_A);
        assertNotNull(ab);
        assertNotNull(ba);
        assertEquals(expected, NostrCrypto.bytesToHex(ab));
        assertEquals(expected, NostrCrypto.bytesToHex(ba));
    }

    @Test
    public void derivesNip04SharedSecret() {
        // The bare ECDH x-coordinate, which NIP-04 uses as its AES key
        // directly — not libsecp's ecdh() helper, which would hash it.
        byte[] shared = NostrCrypto.sharedSecret(SK_A, PK_B);
        assertNotNull(shared);
        assertEquals("d0158a38faf6118af133af12d9bfa388eab4a08d1a2088ea6e6ec1269e03567f",
                NostrCrypto.bytesToHex(shared));

        // It is the x of a point, so both sides reach the same one.
        assertEquals(NostrCrypto.bytesToHex(shared),
                NostrCrypto.bytesToHex(NostrCrypto.sharedSecret(SK_B, PK_A)));
    }

    @Test
    public void rejectsPeersThatAreNotPoints() {
        assertNull(NostrCrypto.sharedSecret(SK_A, "not hex at all, 64 characters long even so, no"));
        assertNull(NostrCrypto.sharedSecret(SK_A, "abcd"));
        assertNull(NostrCrypto.sharedSecret(SK_A, null));
        // Valid hex, valid length, not an x-coordinate on the curve.
        assertNull(NostrCrypto.conversationKey(SK_A,
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
    }

    @Test
    public void computesCanonicalEventId() {
        // Exercises the JSON.stringify-compatible escaping: quotes, backslash,
        // newline, U+0000/U+0001/U+001F control chars, non-ASCII (€) and an
        // astral pair (😀).
        assertEquals(VECTOR_ID,
                NostrCrypto.eventId(PK_A, 1752969600L, 22242, vectorTags(), VECTOR_CONTENT));
    }

    @Test
    public void signsBip340WithFixedAux() throws Exception {
        byte[] msg = NostrCipher.hexToBytes(VECTOR_ID);
        byte[] aux = NostrCipher.hexToBytes(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assertEquals(VECTOR_SIG, NostrCrypto.bytesToHex(NostrCrypto.schnorrSign(msg, SK_A, aux)));
    }

    @Test
    public void verifiesBip340Signature() {
        byte[] msg = NostrCipher.hexToBytes(VECTOR_ID);
        byte[] pk = NostrCipher.hexToBytes(PK_A);
        byte[] sig = NostrCipher.hexToBytes(VECTOR_SIG);
        assertTrue(NostrCrypto.schnorrVerify(msg, pk, sig));

        // Wrong signer must fail.
        assertFalse(NostrCrypto.schnorrVerify(msg, NostrCipher.hexToBytes(PK_B), sig));

        // A single flipped bit, on either side, must fail.
        byte[] badMsg = msg.clone();
        badMsg[0] ^= 0x01;
        assertFalse(NostrCrypto.schnorrVerify(badMsg, pk, sig));
        byte[] badSig = sig.clone();
        badSig[63] ^= 0x01;
        assertFalse(NostrCrypto.schnorrVerify(msg, pk, badSig));

        // Malformed lengths must fail rather than throw.
        assertFalse(NostrCrypto.schnorrVerify(new byte[31], pk, sig));
        assertFalse(NostrCrypto.schnorrVerify(msg, new byte[33], sig));
        assertFalse(NostrCrypto.schnorrVerify(msg, pk, new byte[63]));
    }

    @Test
    public void finalizeEventProducesAVerifiableEvent() throws Exception {
        // The whole path a signEvent call takes, end to end.
        JSONObject signed = NostrCrypto.finalizeEvent(
                22242, VECTOR_CONTENT, vectorTags(), 1752969600L, SK_A);

        assertEquals(PK_A, signed.getString("pubkey"));
        assertEquals(VECTOR_ID, signed.getString("id"));
        assertEquals(1752969600L, signed.getLong("created_at"));
        assertEquals(22242, signed.getInt("kind"));
        assertEquals(VECTOR_CONTENT, signed.getString("content"));

        assertTrue(NostrCrypto.schnorrVerify(
                NostrCipher.hexToBytes(signed.getString("id")),
                NostrCipher.hexToBytes(signed.getString("pubkey")),
                NostrCipher.hexToBytes(signed.getString("sig"))));
    }

    /**
     * What the push service leans on: an event off a relay is only acted on if
     * it is its own. Both halves have to be checked, so both are tampered with
     * here — one changing the contents under a real signature, the other giving
     * a real signature a new id to sit on.
     */
    @Test
    public void verifyEventRejectsAnythingTamperedWith() throws Exception {
        JSONObject signed = NostrCrypto.finalizeEvent(
                1, "hello", vectorTags(), 1752969600L, SK_A);
        assertTrue(NostrCrypto.verifyEvent(signed));

        // Contents changed under a real signature: the id no longer hashes.
        JSONObject edited = new JSONObject(signed.toString());
        edited.put("content", "goodbye");
        assertFalse(NostrCrypto.verifyEvent(edited));

        // Same, with the id recomputed so it matches the new contents. Only
        // the signature catches this one.
        JSONObject reidentified = new JSONObject(edited.toString());
        reidentified.put("id", NostrCrypto.eventId(
                signed.getString("pubkey"), 1752969600L, 1, vectorTags(), "goodbye"));
        assertFalse(NostrCrypto.verifyEvent(reidentified));

        // Attributed to somebody who did not sign it.
        JSONObject reattributed = new JSONObject(signed.toString());
        reattributed.put("pubkey", PK_B);
        assertFalse(NostrCrypto.verifyEvent(reattributed));

        // A different kind, which is a different notification.
        JSONObject rekinded = new JSONObject(signed.toString());
        rekinded.put("kind", 4);
        assertFalse(NostrCrypto.verifyEvent(rekinded));

        // Malformed rather than forged: false, not an exception.
        JSONObject unsigned = new JSONObject(signed.toString());
        unsigned.remove("sig");
        assertFalse(NostrCrypto.verifyEvent(unsigned));
        assertFalse(NostrCrypto.verifyEvent(new JSONObject()));
        assertFalse(NostrCrypto.verifyEvent(new JSONObject().put("sig", "not hex")));
    }

    @Test
    public void signaturesAreNotDeterministicAcrossCalls() throws Exception {
        // BIP-340 with random aux: two signatures over one event differ. A
        // signer that produced the same 64 bytes twice would mean the aux was
        // not random, which is where nonce-reuse disasters start.
        JSONObject one = NostrCrypto.finalizeEvent(1, "hello", new JSONArray(), 1752969600L, SK_A);
        JSONObject two = NostrCrypto.finalizeEvent(1, "hello", new JSONArray(), 1752969600L, SK_A);
        assertEquals(one.getString("id"), two.getString("id"));
        assertNotEquals(one.getString("sig"), two.getString("sig"));
    }

    @Test
    public void generatesUsableKeys() {
        byte[] one = NostrCrypto.generateSecretKey();
        byte[] two = NostrCrypto.generateSecretKey();
        assertEquals(32, one.length);
        assertNotEquals(NostrCrypto.bytesToHex(one), NostrCrypto.bytesToHex(two));
        assertEquals(64, NostrCrypto.pubkeyOf(one).length());
    }
}
