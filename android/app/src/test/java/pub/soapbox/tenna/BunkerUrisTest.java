package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Reading the link a client sends to be connected.
 *
 * <p>Worth pinning because both failures are silent in opposite directions. A
 * parser too strict refuses a connection the user meant to make and says only
 * "that is not a connection link"; one too loose opens relay sockets to
 * whatever a link names, and hands a standing signing permission to whoever
 * wrote it.
 */
public class BunkerUrisTest {

    private static final String CLIENT =
            "83f3b2ae6aa368e8275397b9c26cf550101d63ebaab900d19dd4a4429f5ad8f5";

    @Test
    public void readsTheExampleFromTheNip() {
        BunkerUris.NostrConnect parsed = BunkerUris.parseNostrConnect(
                "nostrconnect://" + CLIENT
                + "?relay=wss%3A%2F%2Frelay1.example.com"
                + "&perms=nip44_encrypt%2Cnip44_decrypt%2Csign_event%3A13"
                + "&name=My+Client"
                + "&secret=0s8j2djs"
                + "&relay=wss%3A%2F%2Frelay2.example2.com");

        assertNotNull(parsed);
        assertEquals(CLIENT, parsed.clientPubkey);
        assertEquals("0s8j2djs", parsed.secret);
        assertEquals(2, parsed.relays.size());
        assertEquals("wss://relay1.example.com", parsed.relays.get(0));
        assertEquals("wss://relay2.example2.com", parsed.relays.get(1));
        // `+` is a space in a query string, and a client's name is prose.
        assertEquals("My Client", parsed.name);
    }

    /**
     * The secret is the only thing telling the client it reached the signer
     * the user meant, rather than whoever scraped the link off a screen.
     */
    @Test
    public void refusesALinkWithNoSecret() {
        assertNull(BunkerUris.parseNostrConnect(
                "nostrconnect://" + CLIENT + "?relay=wss%3A%2F%2Frelay.example.com"));
    }

    /**
     * Relays in the link are where that client is listening. A connection made
     * on relays it never named is one it will never hear an answer on.
     */
    @Test
    public void refusesALinkWithNoRelay() {
        assertNull(BunkerUris.parseNostrConnect("nostrconnect://" + CLIENT + "?secret=abc"));
    }

    @Test
    public void refusesSomethingThatIsNotALink() {
        assertNull(BunkerUris.parseNostrConnect(null));
        assertNull(BunkerUris.parseNostrConnect(""));
        assertNull(BunkerUris.parseNostrConnect("bunker://" + CLIENT + "?secret=a&relay=wss://x.com"));
        assertNull(BunkerUris.parseNostrConnect("https://example.com"));
        // Not a pubkey.
        assertNull(BunkerUris.parseNostrConnect("nostrconnect://hello?secret=a&relay=wss://x.com"));
    }

    /** A relay list is sockets a background service opens and keeps open. */
    @Test
    public void keepsOnlyWebsocketRelays() {
        BunkerUris.NostrConnect parsed = BunkerUris.parseNostrConnect(
                "nostrconnect://" + CLIENT + "?secret=s"
                + "&relay=" + "https%3A%2F%2Fexample.com"
                + "&relay=" + "wss%3A%2F%2Fgood.example.com"
                + "&relay=" + "file%3A%2F%2F%2Fetc%2Fpasswd");

        assertNotNull(parsed);
        assertEquals(1, parsed.relays.size());
        assertEquals("wss://good.example.com", parsed.relays.get(0));
    }

    /** Two spellings of one relay would otherwise be two sockets. */
    @Test
    public void foldsTrailingSlashesAndDuplicates() {
        BunkerUris.NostrConnect parsed = BunkerUris.parseNostrConnect(
                "nostrconnect://" + CLIENT + "?secret=s"
                + "&relay=wss%3A%2F%2Frelay.example.com%2F"
                + "&relay=wss%3A%2F%2Frelay.example.com");

        assertNotNull(parsed);
        assertEquals(1, parsed.relays.size());
        assertEquals("wss://relay.example.com", parsed.relays.get(0));
    }

    @Test
    public void normalizesRelaysOnTheirOwn() {
        assertEquals("wss://a.example.com", BunkerUris.normalizeRelay("  wss://a.example.com/  "));
        assertEquals("ws://localhost:4869", BunkerUris.normalizeRelay("ws://localhost:4869"));
        assertNull(BunkerUris.normalizeRelay("wss://"));
        assertNull(BunkerUris.normalizeRelay("relay.example.com"));
        assertNull(BunkerUris.normalizeRelay(null));
        // Credentials in the authority are somebody else's socket, not ours.
        assertNull(BunkerUris.normalizeRelay("wss://user:pass@example.com"));
    }

    @Test
    public void knowsAPubkeyWhenItSeesOne() {
        assertTrue(BunkerUris.isPubkey(CLIENT));
        assertFalse(BunkerUris.isPubkey(CLIENT.substring(1)));
        assertFalse(BunkerUris.isPubkey(CLIENT.substring(0, 63) + "g"));
        assertFalse(BunkerUris.isPubkey(null));
    }
}
