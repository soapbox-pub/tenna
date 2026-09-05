package pub.soapbox.tenna;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Every file server there is, by the host it answers for.
 *
 * A site's page is served by the {@link NsiteFileServer} its own WebView
 * plugin made, which sniffed the site's document to lay the view out. Its
 * service worker is not: worker fetches go to the one process-wide
 * {@link NsiteServiceWorkers} client, which has to find a server for whichever
 * host asked — including a host with no window open at all, when the push
 * service wakes a worker to hand it an event.
 *
 * So the live servers register here while their window is up, and any other
 * host is answered from its record on disk, built once and kept until the
 * record changes.
 */
final class NsiteFileServers {

    /** Servers with a window, registered by the plugin for as long as it is open. */
    private static final Map<String, NsiteFileServer> LIVE = new ConcurrentHashMap<>();

    /** Servers built from records, keyed by host. */
    private static final Map<String, Cached> STORED = new ConcurrentHashMap<>();

    private static final class Cached {
        final String eventId;
        final NsiteFileServer server;

        Cached(String eventId, NsiteFileServer server) {
            this.eventId = eventId;
            this.server = server;
        }
    }

    private NsiteFileServers() {}

    static void register(@NonNull String host, @NonNull NsiteFileServer server) {
        LIVE.put(host, server);
    }

    /** Only the server that registered may unregister; a newer window may have replaced it. */
    static void unregister(@NonNull String host, @NonNull NsiteFileServer server) {
        LIVE.remove(host, server);
    }

    /** A record was written; whatever was built from the old one is stale. */
    static void invalidate(@NonNull String siteId) {
        STORED.remove(NsiteOrigins.hostFor(siteId));
    }

    /** The server for a host, or null if it is not a site we know. */
    @Nullable
    static NsiteFileServer resolve(@NonNull Context context, @Nullable String host) {
        if (host == null) return null;

        NsiteFileServer live = LIVE.get(host);
        if (live != null) return live;

        String siteId = NsiteOrigins.siteIdFor(host);
        if (siteId == null) return null;

        NsiteSites.Record record = NsiteSites.load(context, siteId);
        if (record == null) {
            STORED.remove(host);
            return null;
        }

        NsiteManifest manifest = NsiteManifest.parse(record.event);
        if (manifest == null) return null;

        Cached cached = STORED.get(host);
        if (cached != null && cached.eventId.equals(manifest.eventId)) return cached.server;

        NsiteFileServer server = NsiteFileServer.forManifest(context.getApplicationContext(), manifest);
        STORED.put(host, new Cached(manifest.eventId, server));
        return server;
    }
}
