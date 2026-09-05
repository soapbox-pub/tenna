package pub.soapbox.tenna;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Every site's subscriptions, regrouped by the relay that has to carry them.
 *
 * The merge is deliberately plain. Each site subscription becomes one REQ on
 * each of its relays, and a relay named by several sites gets one socket
 * carrying all of their REQs. Relays match events against filters far better
 * than a phone would, and a REQ per subscription means an event arrives
 * already labelled with the site and the subscription it was for.
 */
final class NappPlan {

    /** One REQ, as it will be sent to each relay in its subscription's list. */
    static final class Subscription {
        /** The REQ id; unique across sites, stable across rebuilds. */
        @NonNull final String id;
        @NonNull final String siteId;
        /** Position in the site's own list, reported back to its worker. */
        final int index;
        @NonNull final JSONArray filters;
        /**
         * The floor for {@code since} on every filter, raised as events
         * arrive. Shared with the service so a reconnection picks up where
         * the last connection left off.
         */
        @NonNull final AtomicLong since;

        Subscription(@NonNull String id, @NonNull String siteId, int index, @NonNull JSONArray filters, @NonNull AtomicLong since) {
            this.id = id;
            this.siteId = siteId;
            this.index = index;
            this.filters = filters;
            this.since = since;
        }
    }

    @NonNull final Map<String, List<Subscription>> byRelay;
    @NonNull final Set<String> siteIds;

    private NappPlan(@NonNull Map<String, List<Subscription>> byRelay, @NonNull Set<String> siteIds) {
        this.byRelay = byRelay;
        this.siteIds = siteIds;
    }

    /**
     * Lay out the REQs for a set of site records.
     *
     * {@code sinces} is kept by the caller across rebuilds: a subscription
     * that was already running keeps the floor it had reached, and a new one
     * starts from whichever is later of the time it was set and the last
     * event noted for it on disk.
     */
    @NonNull
    static NappPlan build(@NonNull List<NappSubscriptions.Record> records, @NonNull Map<String, AtomicLong> sinces) {
        Map<String, List<Subscription>> byRelay = new HashMap<>();
        Set<String> siteIds = new HashSet<>();
        Set<String> live = new HashSet<>();

        for (NappSubscriptions.Record record : records) {
            String key = NsiteSites.key(record.siteId);

            for (int i = 0; i < record.subscriptions.length(); i++) {
                JSONObject subscription = record.subscriptions.optJSONObject(i);
                if (subscription == null) continue;
                JSONArray filters = subscription.optJSONArray("filters");
                JSONArray relays = subscription.optJSONArray("relays");
                if (filters == null || relays == null || filters.length() == 0 || relays.length() == 0) continue;

                String id = "napp:" + key.substring(0, 12) + ":" + i;
                live.add(id);

                long floor = Math.max(record.updatedAt, record.seenAt(i));
                AtomicLong since = sinces.get(id);
                if (since == null) {
                    since = new AtomicLong(floor);
                    sinces.put(id, since);
                } else {
                    since.accumulateAndGet(floor, Math::max);
                }

                Subscription planned = new Subscription(id, record.siteId, i, filters, since);
                siteIds.add(record.siteId);

                for (int r = 0; r < relays.length(); r++) {
                    String url = relays.optString(r, "");
                    if (url.isEmpty()) continue;
                    List<Subscription> list = byRelay.get(url);
                    if (list == null) {
                        list = new ArrayList<>();
                        byRelay.put(url, list);
                    }
                    list.add(planned);
                }
            }
        }

        // Floors for subscriptions that no longer exist would only grow the
        // map forever.
        sinces.keySet().retainAll(live);

        return new NappPlan(Collections.unmodifiableMap(byRelay), Collections.unmodifiableSet(siteIds));
    }
}
