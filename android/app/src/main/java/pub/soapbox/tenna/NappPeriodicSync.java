package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.VisibleForTesting;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Which sites asked to be woken on a schedule, and the schedule itself.
 *
 * <p>The native half of {@code registration.periodicSync}. A site registers a
 * tag with a {@code minInterval} from its window — the web layer has already
 * asked the user — and it is written down here and handed to WorkManager as one
 * periodic job per site, running as often as the site's most frequent tag
 * wants. Each run wakes the worker once for every tag that is due, which is
 * {@link NappPeriodicSyncWorker}.
 *
 * <p>WorkManager rather than the push service's own clock, because the push
 * service only runs while something is subscribed, and holding a foreground
 * service up for a job that runs every hour is holding a notification in the
 * shade for nothing. WorkManager also outlives a reboot on its own, and waits
 * for a network, which is the one thing a sync needs.
 *
 * <p>Stored as one JSON array per site, in preferences: a handful of tags per
 * site at most, read once per run.
 */
final class NappPeriodicSync {

    private static final String TAG = "NappPeriodicSync";

    private static final String PREFS = "napp-periodic-sync";

    /** WorkManager's own floor for a periodic job, and so this one's. */
    static final long MIN_INTERVAL_MS = TimeUnit.MINUTES.toMillis(15);

    /** How many tags one site may hold. Chromium sets none; a site with this many is not syncing, it is polling. */
    static final int MAX_TAGS = 20;

    /** Key a site's job is enqueued under. */
    private static final String WORK_PREFIX = "napp-periodicsync:";

    static final String INPUT_SITE_ID = "siteId";

    private NappPeriodicSync() {}

    /** One registered tag. */
    static final class Entry {
        @NonNull final String tag;
        final long minInterval;
        /** When it was last delivered, or registered if it never has been. Epoch ms. */
        final long lastRun;

        Entry(@NonNull String tag, long minInterval, long lastRun) {
            this.tag = tag;
            this.minInterval = minInterval;
            this.lastRun = lastRun;
        }
    }

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    @NonNull
    static synchronized List<Entry> get(@NonNull Context context, @NonNull String siteId) {
        return parse(prefs(context).getString(siteId, null));
    }

    @NonNull
    static List<String> tags(@NonNull Context context, @NonNull String siteId) {
        List<String> out = new ArrayList<>();
        for (Entry entry : get(context, siteId)) out.add(entry.tag);
        return out;
    }

    @NonNull
    @VisibleForTesting
    static List<Entry> parse(@Nullable String text) {
        List<Entry> out = new ArrayList<>();
        if (text == null) return out;
        try {
            JSONArray array = new JSONArray(text);
            for (int i = 0; i < array.length(); i++) {
                JSONObject json = array.optJSONObject(i);
                if (json == null) continue;
                String tag = json.optString("tag", "");
                if (tag.isEmpty()) continue;
                out.add(new Entry(
                    tag,
                    Math.max(MIN_INTERVAL_MS, json.optLong("minInterval", MIN_INTERVAL_MS)),
                    json.optLong("lastRun", 0)
                ));
            }
        } catch (JSONException e) {
            // A record nobody can read is a site with nothing scheduled.
        }
        return out;
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /**
     * Register or re-register a tag.
     *
     * <p>A tag the site already has keeps its last run, so re-registering on
     * every page load — which is how most sites call this — does not push the
     * next run back each time. A new one starts its clock now: the first run is
     * a whole interval away, as it is in Chrome.
     *
     * @throws IllegalStateException when the site already has as many tags as it may.
     */
    static synchronized void register(
        @NonNull Context context, @NonNull String siteId, @NonNull String tag, long minInterval
    ) {
        long interval = Math.max(MIN_INTERVAL_MS, minInterval);
        List<Entry> entries = get(context, siteId);
        List<Entry> next = new ArrayList<>(entries.size() + 1);
        boolean found = false;

        for (Entry entry : entries) {
            if (entry.tag.equals(tag)) {
                next.add(new Entry(tag, interval, entry.lastRun));
                found = true;
            } else {
                next.add(entry);
            }
        }

        if (!found) {
            if (entries.size() >= MAX_TAGS) {
                throw new IllegalStateException("Too many periodic sync tags");
            }
            next.add(new Entry(tag, interval, System.currentTimeMillis()));
        }

        write(context, siteId, next);
        schedule(context, siteId, next);
    }

    static synchronized void unregister(@NonNull Context context, @NonNull String siteId, @NonNull String tag) {
        List<Entry> next = new ArrayList<>();
        for (Entry entry : get(context, siteId)) {
            if (!entry.tag.equals(tag)) next.add(entry);
        }
        write(context, siteId, next);
        schedule(context, siteId, next);
    }

    /** Forget every tag a site has, and its job. */
    static synchronized void forget(@NonNull Context context, @NonNull String siteId) {
        write(context, siteId, new ArrayList<>());
        schedule(context, siteId, new ArrayList<>());
    }

    /** Say these tags were just run. */
    static synchronized void ran(@NonNull Context context, @NonNull String siteId, @NonNull List<String> tags, long now) {
        List<Entry> next = new ArrayList<>();
        for (Entry entry : get(context, siteId)) {
            next.add(tags.contains(entry.tag) ? new Entry(entry.tag, entry.minInterval, now) : entry);
        }
        write(context, siteId, next);
    }

    private static void write(@NonNull Context context, @NonNull String siteId, @NonNull List<Entry> entries) {
        if (entries.isEmpty()) {
            prefs(context).edit().remove(siteId).apply();
            return;
        }

        JSONArray array = new JSONArray();
        try {
            for (Entry entry : entries) {
                array.put(new JSONObject()
                    .put("tag", entry.tag)
                    .put("minInterval", entry.minInterval)
                    .put("lastRun", entry.lastRun));
            }
        } catch (JSONException e) {
            // Not reachable: every value is a string or a long.
        }
        prefs(context).edit().putString(siteId, array.toString()).apply();
    }

    // ── When ─────────────────────────────────────────────────────────────────

    /**
     * Which tags are due at {@code now}.
     *
     * <p>A little early counts. A periodic job runs somewhere inside each
     * period rather than on the dot of it, so two runs can land a few minutes
     * short of a full interval apart — and a tag that asked for fifteen minutes
     * and was run fourteen minutes ago would otherwise be skipped and left for
     * the run after, half an hour on. The slack is a quarter of the tag's own
     * interval, and never more than five minutes.
     */
    @NonNull
    @VisibleForTesting
    static List<String> due(@NonNull List<Entry> entries, long now) {
        List<String> out = new ArrayList<>();
        for (Entry entry : entries) {
            long slack = Math.min(entry.minInterval / 4, TimeUnit.MINUTES.toMillis(5));
            if (now - entry.lastRun >= entry.minInterval - slack) out.add(entry.tag);
        }
        return out;
    }

    /** How often a site's job has to run: as often as its most frequent tag. Zero for none. */
    @VisibleForTesting
    static long period(@NonNull List<Entry> entries) {
        long period = 0;
        for (Entry entry : entries) {
            if (period == 0 || entry.minInterval < period) period = entry.minInterval;
        }
        return period;
    }

    private static void schedule(@NonNull Context context, @NonNull String siteId, @NonNull List<Entry> entries) {
        WorkManager work;
        try {
            work = WorkManager.getInstance(context.getApplicationContext());
        } catch (IllegalStateException e) {
            Log.w(TAG, "WorkManager is not available", e);
            return;
        }

        String name = WORK_PREFIX + siteId;
        long period = period(entries);

        if (period == 0) {
            work.cancelUniqueWork(name);
            return;
        }

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                NappPeriodicSyncWorker.class, period, TimeUnit.MILLISECONDS)
            .setConstraints(new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build())
            // A new job would otherwise run straight away, when nothing is due.
            .setInitialDelay(period, TimeUnit.MILLISECONDS)
            .setInputData(new Data.Builder().putString(INPUT_SITE_ID, siteId).build())
            .build();

        // UPDATE keeps a job's place in its period when only the interval has
        // changed, so a site re-registering on every load does not keep
        // pushing its own next run away.
        work.enqueueUniquePeriodicWork(name, ExistingPeriodicWorkPolicy.UPDATE, request);
    }
}
