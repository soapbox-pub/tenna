package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * What a NIP-5A manifest event says about where a site's files are.
 *
 * The Java side of {@code src/lib/nsiteFiles.ts}. The web layer does this
 * parsing for a site it opens itself; this is for the cases where nothing of
 * the web layer is running — a service worker fetching a script while the
 * site's window is gone, or the push service waking one.
 */
final class NsiteManifest {

    /**
     * Where to look when a manifest names no servers of its own. Mirrors
     * {@code APP_BLOSSOM_SERVERS} in {@code src/lib/appBlossom.ts}.
     */
    private static final List<String> DEFAULT_SERVERS = Collections.unmodifiableList(Arrays.asList(
        "https://blossom.ditto.pub/",
        "https://blossom.dreamith.to/",
        "https://blossom.primal.net/"
    ));

    /** The event's id, so a cached parse can be told from a newer one. */
    @NonNull final String eventId;
    /** Manifest path (e.g. {@code /index.html}) to sha256. */
    @NonNull final Map<String, String> files;
    /** Blossom servers to fetch blobs from, most trusted first. */
    @NonNull final List<String> servers;

    private NsiteManifest(@NonNull String eventId, @NonNull Map<String, String> files, @NonNull List<String> servers) {
        this.eventId = eventId;
        this.files = files;
        this.servers = servers;
    }

    /** Parse a manifest event, or return null if the JSON isn't one. */
    @Nullable
    static NsiteManifest parse(@NonNull String eventJson) {
        try {
            JSONObject event = new JSONObject(eventJson);
            String id = event.optString("id", "");
            JSONArray tags = event.optJSONArray("tags");
            if (tags == null) return null;

            Map<String, String> files = new HashMap<>();
            List<String> servers = new ArrayList<>();

            for (int i = 0; i < tags.length(); i++) {
                JSONArray tag = tags.optJSONArray(i);
                if (tag == null || tag.length() < 2) continue;
                String name = tag.optString(0, "");

                if ("path".equals(name) && tag.length() >= 3) {
                    String path = tag.optString(1, "");
                    String sha256 = tag.optString(2, "");
                    // A tag whose hash is not a hash is dropped rather than
                    // refused; see NsiteBlobs for why it is checked at all.
                    if (NsiteBlobs.isPath(path) && NsiteBlobs.isName(sha256)) files.put(path, sha256);
                } else if ("server".equals(name)) {
                    String url = tag.optString(1, "");
                    if (isServer(url)) servers.add(url);
                }
            }

            return new NsiteManifest(
                id,
                Collections.unmodifiableMap(files),
                servers.isEmpty() ? DEFAULT_SERVERS : Collections.unmodifiableList(servers)
            );
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * Whether a {@code server} tag names somewhere blobs can be fetched from.
     *
     * {@code https:} only, as in {@code src/lib/nsiteFiles.ts}. The scheme is
     * the publisher's to write and decides what this app does with the string:
     * {@code http:} is refused by the platform's cleartext policy anyway, and
     * anything else is not a fetch — {@code file:} would have the app read its
     * own storage on the site's behalf, and a scheme whose connection is not
     * an {@link java.net.HttpURLConnection} takes the WebView's I/O thread
     * down with a cast.
     */
    static boolean isServer(String value) {
        if (value == null || value.isEmpty()) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null;
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
