package pub.soapbox.tenna;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * What {@code napp.fetch} may reach.
 *
 * <p>Worth pinning harder than most things in here, because it is the only
 * thing there is. There is no permission prompt in front of {@code napp.fetch}
 * and no second check further down: a site that can talk a URL or an address
 * past this file is a site that has the phone making the request. Every case
 * below is one that a mistake here would turn into a way to read something off
 * the user's own network from a page.
 */
public class NappFetchPolicyTest {

    // ── Schemes and shapes ───────────────────────────────────────────────────

    @Test
    public void allowsOrdinaryHttpsUrls() {
        assertNull(NappFetchPolicy.refuseUrl("https://example.com/"));
        assertNull(NappFetchPolicy.refuseUrl("https://api.example.com:8443/v1/thing?q=1"));
        assertNull(NappFetchPolicy.refuseUrl("https://blossom.example/abc123.png"));
    }

    @Test
    public void refusesEverySchemeButHttps() {
        // http included. The only plaintext hosts a phone can usefully reach
        // are the ones on its own network, and those are refused anyway.
        assertNotNull(NappFetchPolicy.refuseUrl("http://example.com/"));
        assertNotNull(NappFetchPolicy.refuseUrl("file:///etc/hosts"));
        assertNotNull(NappFetchPolicy.refuseUrl("content://media/external/images/1"));
        assertNotNull(NappFetchPolicy.refuseUrl("data:text/plain,hello"));
        assertNotNull(NappFetchPolicy.refuseUrl("javascript:alert(1)"));
        assertNotNull(NappFetchPolicy.refuseUrl("ws://example.com/"));
        assertNotNull(NappFetchPolicy.refuseUrl("intent://scan#Intent;scheme=zxing;end"));
    }

    @Test
    public void refusesWhatIsNotAUrlAtAll() {
        assertNotNull(NappFetchPolicy.refuseUrl(null));
        assertNotNull(NappFetchPolicy.refuseUrl(""));
        assertNotNull(NappFetchPolicy.refuseUrl("/relative/path"));
        assertNotNull(NappFetchPolicy.refuseUrl("example.com"));
        assertNotNull(NappFetchPolicy.refuseUrl("https://"));
        assertNotNull(NappFetchPolicy.refuseUrl("https:// space.example/"));
    }

    @Test
    public void refusesCredentialsInTheUrl() {
        // Sent as an Authorization header before anyone has looked at the
        // host, and carried across a redirect by anything that forgets to
        // strip them.
        assertNotNull(NappFetchPolicy.refuseUrl("https://user:pass@example.com/"));
        assertNotNull(NappFetchPolicy.refuseUrl("https://user@example.com/"));
    }

    // ── Names ────────────────────────────────────────────────────────────────

    @Test
    public void refusesEverywhereTennaServesItself() {
        // Where every nsite lives. Without this a site could reach another
        // site's reserved /.napp/ paths from a context the token check was
        // never written to expect.
        assertNotNull(NappFetchPolicy.refuseUrl("https://abc123.nsite.localhost/.napp/nostr"));
        assertNotNull(NappFetchPolicy.refuseUrl("https://localhost/"));
        assertNotNull(NappFetchPolicy.refuseUrl("https://localhost:8080/"));
        assertNotNull(NappFetchPolicy.refuseHost("LOCALHOST"));
        assertNotNull(NappFetchPolicy.refuseHost("anything.LocalHost"));
    }

    @Test
    public void refusesNamesThatResolveOnTheLocalNetwork() {
        assertNotNull(NappFetchPolicy.refuseHost("printer.local"));
        assertNotNull(NappFetchPolicy.refuseHost("db.internal"));
        assertNotNull(NappFetchPolicy.refuseHost("router.home.arpa"));
        assertNotNull(NappFetchPolicy.refuseHost("facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion"));
    }

    @Test
    public void allowsNamesThatMerelyLookLocal() {
        // A public name is a public name. `local.example.com` resolves in DNS
        // like anything else, and refusing it on the strength of a substring
        // would be the wrong kind of careful.
        assertNull(NappFetchPolicy.refuseHost("local.example.com"));
        assertNull(NappFetchPolicy.refuseHost("localhost.example.com"));
        assertNull(NappFetchPolicy.refuseHost("internal.example.com"));
    }

    // ── Addresses ────────────────────────────────────────────────────────────

    @Test
    public void refusesLoopback() throws UnknownHostException {
        // The case the whole address check exists for: a name under the site's
        // own control, with an A record pointing back at the phone. Perfectly
        // ordinary DNS, and how a page reaches something it should not see.
        assertNotNull(refuse("127.0.0.1"));
        assertNotNull(refuse("127.1.2.3"));
        assertNotNull(refuse("::1"));
    }

    @Test
    public void refusesPrivateRanges() throws UnknownHostException {
        assertNotNull(refuse("10.0.0.1"));
        assertNotNull(refuse("172.16.0.1"));
        assertNotNull(refuse("172.31.255.254"));
        assertNotNull(refuse("192.168.1.1"));
    }

    @Test
    public void refusesLinkLocalAndUnspecified() throws UnknownHostException {
        assertNotNull(refuse("169.254.169.254"));
        assertNotNull(refuse("0.0.0.0"));
        assertNotNull(refuse("::"));
        assertNotNull(refuse("fe80::1"));
    }

    @Test
    public void refusesCarrierGradeNat() throws UnknownHostException {
        // 100.64.0.0/10. On a phone this is the carrier's own network rather
        // than the public internet, and Java has no predicate for it.
        assertNotNull(refuse("100.64.0.1"));
        assertNotNull(refuse("100.127.255.255"));
        // Either side of the range is ordinary public space.
        assertNull(refuse("100.63.255.255"));
        assertNull(refuse("100.128.0.1"));
    }

    @Test
    public void refusesIpv6UniqueLocal() throws UnknownHostException {
        // fc00::/7. Java's isSiteLocalAddress only knows the deprecated
        // fec0::/10, so this range is on us and is the one actually in use.
        assertNotNull(refuse("fc00::1"));
        assertNotNull(refuse("fd12:3456:789a::1"));
    }

    @Test
    public void refusesIpv4WearingAnIpv6Coat() throws UnknownHostException {
        // ::ffff:127.0.0.1 is loopback however it is spelled. Java usually
        // normalises these to an Inet4Address, but "usually" is not a thing to
        // rest a security boundary on, so the mapped form is unwrapped by hand.
        byte[] mapped = new byte[16];
        mapped[10] = (byte) 0xff;
        mapped[11] = (byte) 0xff;
        mapped[12] = 127;
        mapped[15] = 1;
        assertNotNull(NappFetchPolicy.refuseAddress(InetAddress.getByAddress(mapped)));

        byte[] mappedPrivate = new byte[16];
        mappedPrivate[10] = (byte) 0xff;
        mappedPrivate[11] = (byte) 0xff;
        mappedPrivate[12] = (byte) 192;
        mappedPrivate[13] = (byte) 168;
        mappedPrivate[15] = 1;
        assertNotNull(NappFetchPolicy.refuseAddress(InetAddress.getByAddress(mappedPrivate)));
    }

    @Test
    public void refusesReservedAndUnroutable() throws UnknownHostException {
        assertNotNull(refuse("0.1.2.3"));
        assertNotNull(refuse("192.0.0.1"));
        assertNotNull(refuse("198.18.0.1"));
        assertNotNull(refuse("240.0.0.1"));
        assertNotNull(refuse("255.255.255.255"));
        assertNotNull(refuse("224.0.0.1"));
    }

    @Test
    public void allowsOrdinaryPublicAddresses() throws UnknownHostException {
        assertNull(refuse("93.184.216.34"));
        assertNull(refuse("1.1.1.1"));
        assertNull(refuse("8.8.8.8"));
        assertNull(refuse("2606:4700:4700::1111"));
        assertNull(refuse("172.32.0.1"));
        assertNull(refuse("192.167.255.255"));
        assertNull(refuse("11.0.0.1"));
    }

    @Test
    public void refusesNothingToConnectTo() {
        assertNotNull(NappFetchPolicy.refuseAddress(null));
    }

    /** By literal, so nothing here touches a resolver. */
    private static String refuse(String literal) throws UnknownHostException {
        return NappFetchPolicy.refuseAddress(InetAddress.getByName(literal));
    }

    // ── Headers ──────────────────────────────────────────────────────────────

    @Test
    public void refusesHeadersThatDescribeTheConnection() {
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Host"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("connection"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Transfer-Encoding"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Content-Length"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Upgrade"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Proxy-Authorization"));
    }

    @Test
    public void refusesHeadersThatWouldBorrowSomebodysIdentity() {
        // The request is anonymous and stays that way. A site that could set
        // Cookie by hand would have the credential path back.
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Cookie"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("cookie2"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Origin"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Referer"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("X-Forwarded-For"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Forwarded"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Sec-Fetch-Mode"));
    }

    @Test
    public void refusesAcceptEncoding() {
        // Duller than the rest: OkHttp only decompresses when it set the
        // header itself, and a response handed back through interception is
        // not run through Chromium's decoder. A site that asked for gzip would
        // be given gzip and no way to know.
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("Accept-Encoding"));
    }

    @Test
    public void allowsTheHeadersAnApiCallIsMadeOf() {
        assertFalse(NappFetchPolicy.isForbiddenRequestHeader("Authorization"));
        assertFalse(NappFetchPolicy.isForbiddenRequestHeader("Content-Type"));
        assertFalse(NappFetchPolicy.isForbiddenRequestHeader("Accept"));
        assertFalse(NappFetchPolicy.isForbiddenRequestHeader("If-None-Match"));
        assertFalse(NappFetchPolicy.isForbiddenRequestHeader("X-Nostr-Auth"));
    }

    @Test
    public void refusesHeaderNamesThatAreNotNames() {
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader(null));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader(""));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("X Bad"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("X:Bad"));
        assertTrue(NappFetchPolicy.isForbiddenRequestHeader("X\nInjected"));
    }

    @Test
    public void refusesHeaderValuesThatWouldReframeTheRequest() {
        assertFalse(NappFetchPolicy.isValidHeaderValue(null));
        assertFalse(NappFetchPolicy.isValidHeaderValue("one\r\nX-Injected: two"));
        assertFalse(NappFetchPolicy.isValidHeaderValue("one\nTwo"));
        assertTrue(NappFetchPolicy.isValidHeaderValue("Bearer abc.def"));
        assertTrue(NappFetchPolicy.isValidHeaderValue(""));
    }

    @Test
    public void keepsCookiesOutOfWhatTheSiteIsHanded() {
        assertTrue(NappFetchPolicy.isStrippedResponseHeader("Set-Cookie"));
        assertTrue(NappFetchPolicy.isStrippedResponseHeader("set-cookie2"));
        assertTrue(NappFetchPolicy.isStrippedResponseHeader("Content-Encoding"));
        assertTrue(NappFetchPolicy.isStrippedResponseHeader("Transfer-Encoding"));
        assertFalse(NappFetchPolicy.isStrippedResponseHeader("Content-Type"));
        assertFalse(NappFetchPolicy.isStrippedResponseHeader("ETag"));
    }

    // ── Methods ──────────────────────────────────────────────────────────────

    @Test
    public void normalizesTheMethodsASiteMayUse() {
        assertEquals("GET", NappFetchPolicy.normalizeMethod(null));
        assertEquals("GET", NappFetchPolicy.normalizeMethod(""));
        assertEquals("GET", NappFetchPolicy.normalizeMethod("get"));
        assertEquals("PUT", NappFetchPolicy.normalizeMethod("put"));
        assertEquals("DELETE", NappFetchPolicy.normalizeMethod("DELETE"));
    }

    @Test
    public void refusesTheMethodsFetchItselfRefuses() {
        assertNull(NappFetchPolicy.normalizeMethod("CONNECT"));
        assertNull(NappFetchPolicy.normalizeMethod("TRACE"));
        assertNull(NappFetchPolicy.normalizeMethod("TRACK"));
        assertNull(NappFetchPolicy.normalizeMethod("INVENTED"));
    }

    @Test
    public void knowsWhichMethodsCarryABody() {
        assertFalse(NappFetchPolicy.allowsBody("GET"));
        assertFalse(NappFetchPolicy.allowsBody("HEAD"));
        assertTrue(NappFetchPolicy.allowsBody("POST"));
        assertTrue(NappFetchPolicy.allowsBody("PUT"));
    }

    // ── Redirects ────────────────────────────────────────────────────────────

    @Test
    public void followsTheRedirectsFetchFollows() {
        assertTrue(NappFetchPolicy.isRedirect(301));
        assertTrue(NappFetchPolicy.isRedirect(302));
        assertTrue(NappFetchPolicy.isRedirect(303));
        assertTrue(NappFetchPolicy.isRedirect(307));
        assertTrue(NappFetchPolicy.isRedirect(308));
        assertFalse(NappFetchPolicy.isRedirect(300));
        assertFalse(NappFetchPolicy.isRedirect(304));
        assertFalse(NappFetchPolicy.isRedirect(200));
    }

    @Test
    public void turnsAPostIntoAGetWhereEveryBrowserDoes() {
        // Not what the original RFC said, and what every browser has done for
        // thirty years.
        assertTrue(NappFetchPolicy.redirectBecomesGet(301, "POST"));
        assertTrue(NappFetchPolicy.redirectBecomesGet(302, "POST"));
        assertTrue(NappFetchPolicy.redirectBecomesGet(303, "POST"));
        assertTrue(NappFetchPolicy.redirectBecomesGet(303, "GET"));

        // 307 and 308 exist precisely to promise the method survives.
        assertFalse(NappFetchPolicy.redirectBecomesGet(307, "POST"));
        assertFalse(NappFetchPolicy.redirectBecomesGet(308, "PUT"));
        assertFalse(NappFetchPolicy.redirectBecomesGet(301, "GET"));
    }

    // ── Answering ────────────────────────────────────────────────────────────

    @Test
    public void suppliesAReasonPhraseWhenThereIsNone() {
        // HTTP/2 has no reason phrases at all, and a WebResourceResponse is
        // refused without one — so every response over h2 would fail.
        assertEquals("OK", NappFetchPolicy.reasonFor(200, ""));
        assertEquals("OK", NappFetchPolicy.reasonFor(200, null));
        assertEquals("Not Found", NappFetchPolicy.reasonFor(404, "   "));
        assertEquals("Error", NappFetchPolicy.reasonFor(499, null));
        assertEquals("Status", NappFetchPolicy.reasonFor(299, null));
    }

    @Test
    public void keepsAReasonPhraseWhenThereIsOne() {
        assertEquals("Totally Fine", NappFetchPolicy.reasonFor(200, "Totally Fine"));
        assertEquals("Not Found", NappFetchPolicy.reasonFor(404, " Not Found "));
        // Anything that would reframe the status line is replaced.
        assertEquals("OK", NappFetchPolicy.reasonFor(200, "Fine\r\nX-Injected: 1"));
        assertEquals("OK", NappFetchPolicy.reasonFor(200, "Ünicode"));
    }

    @Test
    public void knowsWhichStatusesCanBeServed() {
        assertTrue(NappFetchPolicy.isServableStatus(200));
        assertTrue(NappFetchPolicy.isServableStatus(100));
        assertTrue(NappFetchPolicy.isServableStatus(599));
        assertFalse(NappFetchPolicy.isServableStatus(99));
        assertFalse(NappFetchPolicy.isServableStatus(600));
        assertFalse(NappFetchPolicy.isServableStatus(0));
    }

    @Test
    public void knowsWhichStatusesMustHaveNoBody() {
        assertTrue(NappFetchPolicy.isBodilessStatus(204));
        assertTrue(NappFetchPolicy.isBodilessStatus(205));
        assertTrue(NappFetchPolicy.isBodilessStatus(304));
        assertFalse(NappFetchPolicy.isBodilessStatus(200));
        assertFalse(NappFetchPolicy.isBodilessStatus(404));
    }
}
