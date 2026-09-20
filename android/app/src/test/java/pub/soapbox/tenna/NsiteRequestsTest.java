package pub.soapbox.tenna;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import pub.soapbox.tenna.NsiteRequests.Asker;

/**
 * Who may ask for the paths Tenna reserves under a site's origin.
 *
 * <p>Both halves of that question are pinned here. The token is the other
 * half, and it is not: it needs a {@code Context}, and what it protects is
 * covered by the fact that nothing without it gets past these two checks
 * either.
 */
public class NsiteRequestsTest {

    // ── Which paths are a worker's ───────────────────────────────────────────

    @Test
    public void namesEveryPathOnlyAWorkerAsksFor() {
        // A page has all of this already — the Notifications API and
        // window.nostr are injected into it — so it never comes here for any
        // of them. Anything added to this list has to be true of too.
        assertTrue(NsiteRequests.isWorkerPath("/.napp/notification"));
        assertTrue(NsiteRequests.isWorkerPath("/.napp/notifications"));
        assertTrue(NsiteRequests.isWorkerPath("/.napp/close"));
        assertTrue(NsiteRequests.isWorkerPath("/.napp/open"));
        assertTrue(NsiteRequests.isWorkerPath("/.napp/nostr"));
    }

    @Test
    public void leavesOutTheReservedPathsAWindowUses() {
        // napp.fetch has two legs and a window's is the ordinary one; the wake
        // path is a document, loaded by a document.
        assertFalse(NsiteRequests.isWorkerPath("/.napp/fetch"));
        assertFalse(NsiteRequests.isWorkerPath("/.napp/wake"));
    }

    @Test
    public void leavesTheSitesOwnPathsAlone() {
        assertFalse(NsiteRequests.isWorkerPath("/"));
        assertFalse(NsiteRequests.isWorkerPath("/index.html"));
        assertFalse(NsiteRequests.isWorkerPath("/sw.js"));
        assertFalse(NsiteRequests.isWorkerPath("/.tenna/share"));
        assertFalse(NsiteRequests.isWorkerPath(null));
    }

    @Test
    public void matchesThePathAndNotSomethingNearIt() {
        // The router compares whole paths, so a site is free to have files at
        // names like these and must keep them.
        assertFalse(NsiteRequests.isWorkerPath("/.napp/open/"));
        assertFalse(NsiteRequests.isWorkerPath("/.napp/opening"));
        assertFalse(NsiteRequests.isWorkerPath("/x/.napp/open"));
        assertFalse(NsiteRequests.isWorkerPath(".napp/open"));
    }

    // ── Which client could be carrying one ───────────────────────────────────

    @Test
    public void refusesAWindowWhicheverSiteItIs() {
        // The whole point of the split: a document asking for a worker's API
        // is not a document of ours, whatever it can prove.
        assertFalse(NsiteRequests.askerCouldBe(Asker.window(), "abc"));
        assertFalse(NsiteRequests.askerCouldBe(Asker.window(), "def"));
    }

    @Test
    public void takesAnySiteFromTheSharedWorkerClient() {
        // The default profile's client serves every site left on it, so it
        // cannot say which one is asking and does not pretend to. The token is
        // the only answer there.
        assertTrue(NsiteRequests.askerCouldBe(Asker.worker(), "abc"));
        assertTrue(NsiteRequests.askerCouldBe(Asker.worker(), "def"));
    }

    @Test
    public void takesOnlyItsOwnSiteFromAProfilesWorkerClient() {
        // A client set on one site's profile is reachable by that site's
        // workers and no other's, which is the one thing a host in a URL could
        // never establish.
        assertTrue(NsiteRequests.askerCouldBe(Asker.worker("abc"), "abc"));
        assertFalse(NsiteRequests.askerCouldBe(Asker.worker("abc"), "def"));
        assertFalse(NsiteRequests.askerCouldBe(Asker.worker("abc"), "ab"));
        assertFalse(NsiteRequests.askerCouldBe(Asker.worker("abc"), "abcd"));
    }
}
