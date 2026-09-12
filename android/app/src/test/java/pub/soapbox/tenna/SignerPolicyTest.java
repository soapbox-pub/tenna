package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * How a remembered answer is matched against a new question, and how a
 * question is read out of what a caller sent.
 *
 * <p>Both halves of the file-backed store need a {@code Context} and are not
 * reachable from a plain JVM test; what is here is the part that decides
 * things. That is the part worth pinning anyway — a matching rule that is one
 * degree too broad is an application signing a kind nobody agreed to, and it
 * would never look like an error from either side.
 */
public class SignerPolicyTest {

    private static SignerApps.Permission signing(Integer kind, boolean allowed) {
        return new SignerApps.Permission(SignerTypes.PERM_SIGN_EVENT, kind, allowed);
    }

    // ── Matching ─────────────────────────────────────────────────────────────

    @Test
    public void signingIsRememberedPerKind() {
        SignerApps.Permission note = signing(1, true);

        assertTrue(note.matches(SignerTypes.PERM_SIGN_EVENT, 1));
        assertFalse(note.matches(SignerTypes.PERM_SIGN_EVENT, 7));
        assertFalse(note.matches(SignerTypes.PERM_SIGN_EVENT, null));
    }

    /**
     * Everything that is not signing is one question. An app allowed to
     * decrypt has been allowed to decrypt, and there is nothing in the request
     * that would make one instance of it different from another.
     */
    @Test
    public void everythingElseIsRememberedOnce() {
        SignerApps.Permission decrypt =
                new SignerApps.Permission(SignerTypes.PERM_NIP44_DECRYPT, null, true);

        assertTrue(decrypt.matches(SignerTypes.PERM_NIP44_DECRYPT, null));
        // A kind is meaningless here, and is not allowed to make it miss.
        assertTrue(decrypt.matches(SignerTypes.PERM_NIP44_DECRYPT, 4));
        assertFalse(decrypt.matches(SignerTypes.PERM_NIP44_ENCRYPT, null));
    }

    @Test
    public void aBlanketSigningGrantIsItsOwnEntry() {
        SignerApps.Permission anyKind = signing(null, true);

        assertTrue(anyKind.matches(SignerTypes.PERM_SIGN_EVENT, null));
        // It does not *match* a specific kind; `SignerApps.decide` falls back
        // to it separately, so that a specific answer always outranks it.
        assertFalse(anyKind.matches(SignerTypes.PERM_SIGN_EVENT, 1));
    }

    @Test
    public void aRememberedNoIsStillAMatch() {
        SignerApps.Permission refused = signing(1, false);

        assertTrue(refused.matches(SignerTypes.PERM_SIGN_EVENT, 1));
        assertFalse(refused.allowed);
    }

    // ── Reading the request ──────────────────────────────────────────────────

    private static TennaSigning.Request signRequest(String json) {
        return new TennaSigning.Request(SignerTypes.Method.SIGN_EVENT, json, null);
    }

    @Test
    public void findsTheKindAnEventWouldBe() {
        assertEquals(Integer.valueOf(1),
                signRequest("{\"kind\":1,\"content\":\"hello\",\"tags\":[]}").eventKind());
        assertEquals(Integer.valueOf(22242),
                signRequest("{\"kind\":22242,\"tags\":[[\"relay\",\"wss://x\"]]}").eventKind());
    }

    /**
     * A request whose kind cannot be read asks to sign "no kind in
     * particular", which matches only a blanket grant — so a malformed event
     * cannot borrow the grant given for kind 1.
     */
    @Test
    public void hasNoKindWhenTheEventCannotBeRead() {
        assertNull(signRequest("not json at all").eventKind());
        assertNull(signRequest("{\"content\":\"no kind here\"}").eventKind());
        assertNull(signRequest("{\"kind\":\"one\"}").eventKind());
    }

    @Test
    public void onlySigningHasAKind() {
        TennaSigning.Request decrypt = new TennaSigning.Request(
                SignerTypes.Method.NIP44_DECRYPT, "{\"kind\":1}", "ab");
        assertNull(decrypt.eventKind());
        assertNull(decrypt.eventAuthor());
    }

    @Test
    public void findsTheAuthorAnEventNames() {
        String pubkey = "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
        assertEquals(pubkey, signRequest("{\"kind\":1,\"pubkey\":\"" + pubkey + "\"}").eventAuthor());
    }

    /** A pubkey that is not one is not a pubkey, and must not select an account. */
    @Test
    public void refusesAnAuthorThatIsNotAKey() {
        assertNull(signRequest("{\"kind\":1}").eventAuthor());
        assertNull(signRequest("{\"kind\":1,\"pubkey\":\"\"}").eventAuthor());
        assertNull(signRequest("{\"kind\":1,\"pubkey\":\"abc\"}").eventAuthor());
    }
}
