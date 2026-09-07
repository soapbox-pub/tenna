package pub.soapbox.tenna;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * What a site's notifications currently say, for the questions the shade asks
 * that a web notification never has to answer.
 *
 * <b>Where does a tap go?</b> A notification outlives the process that posted
 * it. The tap may arrive days later, cold, with nothing in memory, so the
 * route and everything the site attached are written down.
 *
 * <b>What does the site have out?</b> {@code getNotifications()} is a real
 * method and has to answer with the site's own live notifications — and the
 * one row the site occupies is drawn from them, so a record is what puts a
 * notification on screen rather than a note about one that is.
 *
 * One file per site, replaced whole. These are small, there are at most
 * {@link #MAX_PER_SITE} of them, and they are read on the path to showing a
 * notification the user is already waiting for.
 */
final class NappNotificationStore {

    private static final String DIRECTORY = "napp-notifications";

    /** Live notifications remembered per site. Android's own tray cap is 25. */
    private static final int MAX_PER_SITE = 32;

    /** A record nothing has touched in this long is not coming back. */
    private static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;

    private NappNotificationStore() {}

    /** One notification, as it stands in the tray. */
    static final class Entry {
        /** The tag {@code notify()} was called with — unique within the app. */
        @NonNull final String key;
        /** The tag the site chose, or empty when it chose none. */
        @NonNull final String tag;
        @NonNull final String title;
        /** The options the site passed, as JSON text, for {@code getNotifications}. */
        @NonNull final String options;
        /** Where a tap goes, as a site-absolute path, or null for the front page. */
        @Nullable final String url;
        final long postedAt;

        Entry(
            @NonNull String key,
            @NonNull String tag,
            @NonNull String title,
            @NonNull String options,
            @Nullable String url,
            long postedAt
        ) {
            this.key = key;
            this.tag = tag;
            this.title = title;
            this.options = options;
            this.url = url;
            this.postedAt = postedAt;
        }

        @NonNull
        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("key", key);
            json.put("tag", tag);
            json.put("title", title);
            json.put("options", options);
            if (url != null) json.put("url", url);
            json.put("postedAt", postedAt);
            return json;
        }

        @Nullable
        static Entry fromJson(@Nullable JSONObject json) {
            if (json == null) return null;

            String key = json.optString("key", null);
            String title = json.optString("title", null);
            String options = json.optString("options", null);
            if (key == null || title == null || options == null) return null;

            return new Entry(
                key,
                json.optString("tag", ""),
                title,
                options,
                json.optString("url", null),
                json.optLong("postedAt", 0)
            );
        }
    }

    // -----------------------------------------------------------------------

    /** Every live notification for a site, newest last. */
    @NonNull
    static synchronized List<Entry> list(@NonNull Context context, @NonNull String siteId) {
        List<Entry> entries = new ArrayList<>();
        JSONObject stored = read(context, siteId);
        long now = System.currentTimeMillis();

        for (Iterator<String> keys = stored.keys(); keys.hasNext(); ) {
            Entry entry = Entry.fromJson(stored.optJSONObject(keys.next()));
            if (entry == null) continue;
            if (now - entry.postedAt > MAX_AGE_MS) continue;
            entries.add(entry);
        }

        Collections.sort(entries, (a, b) -> Long.compare(a.postedAt, b.postedAt));
        return entries;
    }

    @Nullable
    static synchronized Entry get(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        return Entry.fromJson(read(context, siteId).optJSONObject(key));
    }

    /** Write a notification down, evicting the oldest if the site has too many. */
    static synchronized void put(@NonNull Context context, @NonNull String siteId, @NonNull Entry entry) {
        JSONObject stored = read(context, siteId);
        try {
            stored.put(entry.key, entry.toJson());
        } catch (JSONException e) {
            return;
        }

        while (stored.length() > MAX_PER_SITE) {
            String oldest = null;
            long oldestAt = Long.MAX_VALUE;
            for (Iterator<String> keys = stored.keys(); keys.hasNext(); ) {
                String key = keys.next();
                JSONObject json = stored.optJSONObject(key);
                long at = json == null ? 0 : json.optLong("postedAt", 0);
                if (at < oldestAt) {
                    oldestAt = at;
                    oldest = key;
                }
            }
            if (oldest == null) break;
            stored.remove(oldest);
        }

        write(context, siteId, stored);
    }

    static synchronized void remove(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        JSONObject stored = read(context, siteId);
        if (!stored.has(key)) return;
        stored.remove(key);
        write(context, siteId, stored);
    }

    /** Forget a site's notifications entirely — it lost its permission, or its record. */
    static synchronized void clear(@NonNull Context context, @NonNull String siteId) {
        //noinspection ResultOfMethodCallIgnored
        file(context, siteId).delete();
    }

    // -----------------------------------------------------------------------

    @NonNull
    private static JSONObject read(Context context, String siteId) {
        File file = file(context, siteId);
        if (!file.exists()) return new JSONObject();

        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return new JSONObject();
        }
    }

    private static void write(Context context, String siteId, JSONObject stored) {
        File file = file(context, siteId);

        if (stored.length() == 0) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }

        try (OutputStream out = new FileOutputStream(file)) {
            out.write(stored.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // Nothing is lost but this site's row, which the next push
            // rebuilds; better an empty file than half of one.
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static File file(Context context, String siteId) {
        File dir = new File(context.getFilesDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, NsiteSites.key(siteId) + ".json");
    }
}
