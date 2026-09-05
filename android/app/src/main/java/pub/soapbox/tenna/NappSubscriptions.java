package pub.soapbox.tenna;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * What each nsite asked to be told about, on disk.
 *
 * A site sets its subscriptions through {@code window.napp.push.set()} while
 * it is open, and expects to hear about matching events long after it has
 * closed — so the list lives here, where the push service can read it with
 * no site and no web layer running. One file per site, named the way a
 * site's other records are.
 *
 * Also kept: how far each subscription has got, so a restart asks relays for
 * what came after the last event delivered rather than for the last day.
 */
final class NappSubscriptions {

    private static final String DIRECTORY = "napp/subscriptions";

    static final int MAX_SUBSCRIPTIONS = 10;
    static final int MAX_FILTERS = 10;
    static final int MAX_RELAYS = 10;
    /** Longest list a filter may carry — ids, authors, tag values. */
    private static final int MAX_LIST = 500;

    private NappSubscriptions() {}

    /** A site's subscriptions, as stored. */
    static final class Record {
        final String siteId;
        final String label;
        /** Normalized array of {@code {filters, relays}} objects. */
        final JSONArray subscriptions;
        /** When the site last set them, unix seconds. */
        final long updatedAt;
        /** Subscription index, as a string, to the created_at of the newest event delivered. */
        final JSONObject seen;

        Record(String siteId, String label, JSONArray subscriptions, long updatedAt, JSONObject seen) {
            this.siteId = siteId;
            this.label = label;
            this.subscriptions = subscriptions;
            this.updatedAt = updatedAt;
            this.seen = seen;
        }

        long seenAt(int index) {
            return seen.optLong(String.valueOf(index), 0);
        }
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    @Nullable
    static Record get(@NonNull Context context, @NonNull String siteId) {
        return read(fileFor(context, siteId));
    }

    static boolean has(@NonNull Context context, @NonNull String siteId) {
        return fileFor(context, siteId).exists();
    }

    @NonNull
    static List<Record> all(@NonNull Context context) {
        List<Record> records = new ArrayList<>();
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return records;
        for (File file : files) {
            Record record = read(file);
            if (record != null && record.subscriptions.length() > 0) records.add(record);
        }
        return records;
    }

    @Nullable
    private static Record read(File file) {
        if (!file.exists()) return null;
        try {
            JSONObject json = new JSONObject(new String(readFully(file), StandardCharsets.UTF_8));
            String siteId = json.optString("siteId", null);
            JSONArray subscriptions = json.optJSONArray("subscriptions");
            if (siteId == null || subscriptions == null) return null;
            JSONObject seen = json.optJSONObject("seen");
            return new Record(
                siteId,
                json.optString("label", siteId),
                subscriptions,
                json.optLong("updatedAt", 0),
                seen == null ? new JSONObject() : seen
            );
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Writing
    // -----------------------------------------------------------------------

    /**
     * Replace a site's subscriptions. An empty list forgets the site.
     *
     * {@code subscriptions} must already be {@link #normalize normalized}.
     */
    static synchronized void set(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String label,
        @NonNull JSONArray subscriptions
    ) throws IOException {
        if (subscriptions.length() == 0) {
            remove(context, siteId);
            return;
        }

        JSONObject json = new JSONObject();
        try {
            json.put("siteId", siteId);
            json.put("label", label);
            json.put("subscriptions", subscriptions);
            json.put("updatedAt", System.currentTimeMillis() / 1000);
            // A re-set starts every subscription from now; what was seen
            // under the old list says nothing about the new one.
            json.put("seen", new JSONObject());
        } catch (JSONException e) {
            throw new IOException("Could not serialize subscriptions", e);
        }

        write(fileFor(context, siteId), json.toString().getBytes(StandardCharsets.UTF_8));
    }

    static synchronized void remove(@NonNull Context context, @NonNull String siteId) {
        //noinspection ResultOfMethodCallIgnored
        fileFor(context, siteId).delete();
    }

    /** Note the newest event delivered for one subscription, if it is newer than the last noted. */
    static synchronized void markSeen(@NonNull Context context, @NonNull String siteId, int index, long createdAt) {
        File file = fileFor(context, siteId);
        Record record = read(file);
        if (record == null) return;
        if (createdAt <= record.seenAt(index)) return;

        try {
            JSONObject json = new JSONObject(new String(readFully(file), StandardCharsets.UTF_8));
            JSONObject seen = json.optJSONObject("seen");
            if (seen == null) seen = new JSONObject();
            seen.put(String.valueOf(index), createdAt);
            json.put("seen", seen);
            write(file, json.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException | JSONException ignored) {
            // The floor stays where it was; the dedupe in the service covers
            // the repeat.
        }
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    /**
     * Check and tidy what a site sent, or throw with a reason it can be told.
     *
     * The web layer has already validated the same shape; this is the copy
     * that runs on what actually gets stored. Filters keep only the keys a
     * relay indexes, lose their {@code limit} — a standing subscription has
     * no use for one — and must name something: an empty filter is every
     * event the relay sees.
     */
    @NonNull
    static JSONArray normalize(@NonNull JSONArray raw) throws IllegalArgumentException {
        if (raw.length() > MAX_SUBSCRIPTIONS) {
            throw new IllegalArgumentException("At most " + MAX_SUBSCRIPTIONS + " subscriptions");
        }

        JSONArray out = new JSONArray();
        try {
            for (int i = 0; i < raw.length(); i++) {
                JSONObject subscription = raw.optJSONObject(i);
                if (subscription == null) throw new IllegalArgumentException("Subscription " + i + " is not an object");

                JSONArray filters = subscription.optJSONArray("filters");
                JSONArray relays = subscription.optJSONArray("relays");
                if (filters == null || filters.length() == 0) throw new IllegalArgumentException("Subscription " + i + " has no filters");
                if (relays == null || relays.length() == 0) throw new IllegalArgumentException("Subscription " + i + " has no relays");
                if (filters.length() > MAX_FILTERS) throw new IllegalArgumentException("At most " + MAX_FILTERS + " filters per subscription");
                if (relays.length() > MAX_RELAYS) throw new IllegalArgumentException("At most " + MAX_RELAYS + " relays per subscription");

                JSONArray cleanFilters = new JSONArray();
                for (int f = 0; f < filters.length(); f++) {
                    JSONObject filter = filters.optJSONObject(f);
                    if (filter == null) throw new IllegalArgumentException("Filter " + f + " of subscription " + i + " is not an object");
                    cleanFilters.put(normalizeFilter(filter, i));
                }

                Set<String> cleanRelays = new LinkedHashSet<>();
                for (int r = 0; r < relays.length(); r++) {
                    String url = normalizeRelay(relays.optString(r, ""));
                    if (url == null) throw new IllegalArgumentException("Relay " + r + " of subscription " + i + " is not a ws:// or wss:// URL");
                    cleanRelays.add(url);
                }

                JSONObject clean = new JSONObject();
                clean.put("filters", cleanFilters);
                clean.put("relays", new JSONArray(new ArrayList<>(cleanRelays)));
                out.put(clean);
            }
        } catch (JSONException e) {
            throw new IllegalArgumentException("Malformed subscriptions", e);
        }
        return out;
    }

    private static JSONObject normalizeFilter(JSONObject filter, int subscription) throws JSONException {
        JSONObject clean = new JSONObject();
        boolean named = false;

        for (Iterator<String> keys = filter.keys(); keys.hasNext(); ) {
            String key = keys.next();
            Object value = filter.get(key);

            switch (key) {
                case "ids":
                case "authors":
                    clean.put(key, stringList(value, key));
                    named = true;
                    break;
                case "kinds":
                    clean.put(key, intList(value));
                    named = true;
                    break;
                case "since":
                case "until":
                    if (!(value instanceof Number)) throw new IllegalArgumentException("Filter " + key + " must be a number");
                    clean.put(key, ((Number) value).longValue());
                    break;
                case "search":
                    if (!(value instanceof String)) throw new IllegalArgumentException("Filter search must be a string");
                    clean.put(key, value);
                    named = true;
                    break;
                case "limit":
                    // Meaningless for a standing subscription; dropped.
                    break;
                default:
                    if (key.length() == 2 && key.charAt(0) == '#' && Character.isLetter(key.charAt(1))) {
                        clean.put(key, stringList(value, key));
                        named = true;
                    } else {
                        throw new IllegalArgumentException("Filter key " + key + " is not supported");
                    }
            }
        }

        if (!named) {
            throw new IllegalArgumentException("A filter in subscription " + subscription + " matches everything; name ids, authors, kinds, a tag or a search");
        }
        return clean;
    }

    private static JSONArray stringList(Object value, String key) throws JSONException {
        if (!(value instanceof JSONArray)) throw new IllegalArgumentException("Filter " + key + " must be an array of strings");
        JSONArray list = (JSONArray) value;
        if (list.length() > MAX_LIST) throw new IllegalArgumentException("Filter " + key + " is too long");
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            Object item = list.get(i);
            if (!(item instanceof String)) throw new IllegalArgumentException("Filter " + key + " must be an array of strings");
            out.put(item);
        }
        return out;
    }

    private static JSONArray intList(Object value) throws JSONException {
        if (!(value instanceof JSONArray)) throw new IllegalArgumentException("Filter kinds must be an array of integers");
        JSONArray list = (JSONArray) value;
        if (list.length() > MAX_LIST) throw new IllegalArgumentException("Filter kinds is too long");
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            Object item = list.get(i);
            if (!(item instanceof Number)) throw new IllegalArgumentException("Filter kinds must be an array of integers");
            out.put(((Number) item).intValue());
        }
        return out;
    }

    @Nullable
    private static String normalizeRelay(String raw) {
        String url = raw.trim();
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("wss") && !scheme.equals("ws")) return null;
            if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        } catch (URISyntaxException e) {
            return null;
        }
        return url.replaceAll("/+$", "");
    }

    // -----------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------

    private static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private static File fileFor(Context context, String siteId) {
        return new File(directory(context), NsiteSites.key(siteId) + ".json");
    }

    private static void write(File destination, byte[] bytes) throws IOException {
        File temp = File.createTempFile("subs", null, destination.getParentFile());
        try (OutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw e;
        }
        //noinspection ResultOfMethodCallIgnored
        destination.delete();
        if (!temp.renameTo(destination)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw new IOException("Could not write " + destination.getName());
        }
    }

    private static byte[] readFully(File file) throws IOException {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }
}
