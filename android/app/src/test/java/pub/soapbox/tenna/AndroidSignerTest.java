package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * What Tenna will accept from another signer app.
 *
 * <p>This is the one place in the signer where the answer comes from a process
 * Tenna does not control, so it is the one place where a signature has to be
 * checked rather than produced. Two separate things can go wrong and only one
 * of them looks like an error: an event that is not really signed is caught by
 * anybody, but an event that is perfectly signed by the <em>wrong key</em>, or
 * that says something other than what the user was shown, is valid everywhere
 * and wrong only here.
 *
 * <p>So these tests are about the second kind. A signer app holding several
 * accounts answering as the wrong one would log a client in as somebody it
 * never asked for; a signer app returning a different body than the sheet
 * displayed would make the user's consent meaningless.
 */
public class AndroidSignerTest {

    private static final byte[] SK = NostrCipher.hexToBytes(
            "0303030303030303030303030303030303030303030303030303030303030303");
    private static final byte[] OTHER_SK = NostrCipher.hexToBytes(
            "0404040404040404040404040404040404040404040404040404040404040404");

    private static final long WHEN = 1_700_000_000L;

    private static JSONArray tags() throws Exception {
        return new JSONArray()
                .put(new JSONArray().put("relay").put("wss://relay.ditto.pub/"))
                .put(new JSONArray().put("challenge").put("abc123"));
    }

    /** What a client asked to have signed. */
    private static String asked(String content) throws Exception {
        return new JSONObject()
                .put("kind", 22242)
                .put("content", content)
                .put("tags", tags())
                .put("created_at", WHEN)
                .toString();
    }

    /** What a signer app answered with. */
    private static String answered(byte[] sk, int kind, String content, JSONArray tags)
            throws Exception {
        return NostrCrypto.finalizeEvent(kind, content, tags, WHEN, sk).toString();
    }

    private static String pubkey(byte[] sk) throws Exception {
        return NostrCrypto.pubkeyOf(sk);
    }

    // ── The good case ────────────────────────────────────────────────────────

    @Test
    public void acceptsTheEventThatWasAskedFor() throws Exception {
        String account = pubkey(SK);
        String event = answered(SK, 22242, "", tags());

        TennaSigning.Outcome outcome = AndroidSigner.signed(account, asked(""), event, null);

        assertEquals(TennaSigning.Outcome.Status.RESULT, outcome.status);
        assertEquals(event, outcome.eventJson);
        // No `result` column came back, so the signature off the event itself
        // is the answer — which is what a client asked for a signature wants.
        assertEquals(new JSONObject(event).getString("sig"), outcome.value);
    }

    @Test
    public void acceptsACreatedAtTheSignerFilledIn() throws Exception {
        // A request may leave the time out, and then putting one in is the
        // signer's job rather than a substitution.
        String account = pubkey(SK);
        String asked = new JSONObject()
                .put("kind", 1)
                .put("content", "hello")
                .put("tags", new JSONArray())
                .toString();

        String event = answered(SK, 1, "hello", new JSONArray());

        assertNull(AndroidSigner.mismatch(account, asked, event));
    }

    @Test
    public void acceptsAHashInTheContent() throws Exception {
        // Worth its own case: the payload travels to the other signer in a
        // URI, where a `#` is where the fragment starts. A note with a hashtag
        // in it is the most ordinary thing a client can ask for.
        String account = pubkey(SK);
        String content = "signing from tenna #bitcoin";

        String asked = new JSONObject()
                .put("kind", 1)
                .put("content", content)
                .put("tags", new JSONArray())
                .toString();

        assertNull(AndroidSigner.mismatch(
                account, asked, answered(SK, 1, content, new JSONArray())));
    }

    // ── The wrong signer ─────────────────────────────────────────────────────

    @Test
    public void refusesAnEventSignedByAnotherAccount() throws Exception {
        // Perfectly signed, and by somebody nobody asked for. A client that
        // named an account and got this would be logged in as a stranger.
        String account = pubkey(SK);
        String event = answered(OTHER_SK, 22242, "", tags());

        assertEquals("a different account",
                AndroidSigner.mismatch(account, asked(""), event));

        TennaSigning.Outcome outcome = AndroidSigner.signed(account, asked(""), event, null);
        assertEquals(TennaSigning.Outcome.Status.ERROR, outcome.status);
        assertNotNull(outcome.error);
    }

    // ── The wrong event ──────────────────────────────────────────────────────

    @Test
    public void refusesDifferentContent() throws Exception {
        String account = pubkey(SK);
        String event = answered(SK, 1, "something else", new JSONArray());

        String asked = new JSONObject()
                .put("kind", 1)
                .put("content", "what the sheet showed")
                .put("tags", new JSONArray())
                .toString();

        assertEquals("different content", AndroidSigner.mismatch(account, asked, event));
    }

    @Test
    public void refusesADifferentKind() throws Exception {
        String account = pubkey(SK);

        assertEquals("a different kind of event", AndroidSigner.mismatch(
                account, asked(""), answered(SK, 1, "", tags())));
    }

    @Test
    public void refusesDifferentTags() throws Exception {
        // The relay AUTH case, and the reason tags are compared at all: the
        // whole meaning of the event the user approved is in its challenge.
        String account = pubkey(SK);

        JSONArray swapped = new JSONArray()
                .put(new JSONArray().put("relay").put("wss://relay.example.com/"))
                .put(new JSONArray().put("challenge").put("abc123"));

        assertEquals("different tags", AndroidSigner.mismatch(
                account, asked(""), answered(SK, 22242, "", swapped)));
    }

    @Test
    public void refusesTagsTheSignerAddedOnItsOwn() throws Exception {
        String account = pubkey(SK);

        JSONArray extra = tags();
        extra.put(new JSONArray().put("p").put(pubkey(OTHER_SK)));

        assertEquals("different tags", AndroidSigner.mismatch(
                account, asked(""), answered(SK, 22242, "", extra)));
    }

    // ── Not an event at all ──────────────────────────────────────────────────

    @Test
    public void refusesAnEventThatIsNotSigned() throws Exception {
        // Everything matches what was asked; only the signature is nonsense.
        String account = pubkey(SK);

        JSONObject event = new JSONObject(answered(SK, 22242, "", tags()));
        event.put("sig", "00".repeat(64));

        TennaSigning.Outcome outcome =
                AndroidSigner.signed(account, asked(""), event.toString(), null);

        assertEquals(TennaSigning.Outcome.Status.ERROR, outcome.status);
        assertTrue(outcome.error, outcome.error.contains("signature"));
    }

    @Test
    public void refusesRubbish() {
        assertNotNull(AndroidSigner.mismatch(
                "0".repeat(64), "{\"kind\":1}", "not an event at all"));
    }
}
