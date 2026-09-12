package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

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
 * Every subscription this device is holding open, regrouped by relay.
 *
 * The merge is deliberately plain. Each subscription becomes one REQ on each
 * of its relays, and a relay named by several of them gets one socket carrying
 * all the REQs. Relays match events against filters far better than a phone
 * would, and a REQ per subscription means an event arrives already labelled
 * with what it was for.
 *
 * Two kinds ride the same sockets. A site's subscription is whatever that site
 * asked to be notified about; a connection's is the one filter a remote signer
 * needs — kind 24133 addressed to the connection's own key. They are kept
 * apart by {@link Subscription#bunkerPubkey} and nothing else, because from
 * the socket's point of view there is no difference between them.
 */
final class NappPlan {

    /** One REQ, as it will be sent to each relay in its subscription's list. */
    static final class Subscription {
        /** The REQ id; unique across sites, stable across rebuilds. */
        @NonNull final String id;
        /** The site this is for, or empty when it is a connection's. */
        @NonNull final String siteId;
        /** Position in the site's own list, reported back to its worker. */
        final int index;
        /**
         * The connection this is for, or null when it is a site's.
         *
         * Also the key the answer will be signed with, and the {@code p} tag
         * the client is addressing — so it is the whole of what the service
         * needs to route an arriving request.
         */
        @Nullable final String bunkerPubkey;
        @NonNull final JSONArray filters;
        /**
         * The floor for {@code since} on every filter, raised as events
         * arrive. Shared with the service so a reconnection picks up where
         * the last connection left off.
         */
        @NonNull final AtomicLong since;

        Subscription(@NonNull String id, @NonNull String siteId, int index,
                     @Nullable String bunkerPubkey, @NonNull JSONArray filters,
                     @NonNull AtomicLong since) {
            this.id = id;
            this.siteId = siteId;
            this.index = index;
            this.bunkerPubkey = bunkerPubkey;
            this.filters = filters;
            this.since = since;
        }

        /** Whether this carries requests for a remote signer rather than a site. */
        boolean isBunker() {
            return bunkerPubkey != null;
        }
    }

    @NonNull final Map<String, List<Subscription>> byRelay;
    @NonNull final Set<String> siteIds;
    /** How many connections are being listened for, for the service's notification. */
    final int connectionCount;

    private NappPlan(@NonNull Map<String, List<Subscription>> byRelay,
                     @NonNull Set<String> siteIds, int connectionCount) {
        this.byRelay = byRelay;
        this.siteIds = siteIds;
        this.connectionCount = connectionCount;
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
    static NappPlan build(@NonNull List<NappSubscriptions.Record> records,
                          @NonNull List<BunkerConnections.Connection> connections,
                          @NonNull Map<String, AtomicLong> sinces) {
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

                Subscription planned = new Subscription(id, record.siteId, i, null, filters, since);
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

        for (BunkerConnections.Connection connection : connections) {
            if (connection.relays.isEmpty()) continue;

            String id = "bunker:" + connection.localPubkey.substring(0, 12);
            live.add(id);

            JSONArray filters = bunkerFilter(connection.localPubkey);
            if (filters == null) continue;

            // No floor at all, and this is load-bearing rather than an
            // omission. Kind 24133 is ephemeral, so there is no history to
            // skip past — but more than that, a `since` here is measured by
            // this phone's clock and compared against a `created_at` written
            // by the client's. A phone a few seconds fast filters out every
            // request made in those seconds, which is all of them, and the
            // symptom is a connection that is plainly established and then
            // silently answers nothing.
            //
            // Zero means `NappRelay.request` leaves `since` off the filter.
            AtomicLong since = sinces.get(id);
            if (since == null) {
                since = new AtomicLong(0);
                sinces.put(id, since);
            }

            Subscription planned = new Subscription(id, "", -1, connection.localPubkey, filters, since);

            for (String url : connection.relays) {
                List<Subscription> list = byRelay.get(url);
                if (list == null) {
                    list = new ArrayList<>();
                    byRelay.put(url, list);
                }
                list.add(planned);
            }
        }

        // Floors for subscriptions that no longer exist would only grow the
        // map forever.
        sinces.keySet().retainAll(live);

        return new NappPlan(Collections.unmodifiableMap(byRelay),
            Collections.unmodifiableSet(siteIds), connections.size());
    }

    /** The one filter a remote signer needs: requests addressed to this connection. */
    @Nullable
    private static JSONArray bunkerFilter(@NonNull String localPubkey) {
        try {
            JSONObject filter = new JSONObject();
            filter.put("kinds", new JSONArray().put(NappBunker.KIND));
            filter.put("#p", new JSONArray().put(localPubkey));
            return new JSONArray().put(filter);
        } catch (org.json.JSONException e) {
            return null;
        }
    }
}
