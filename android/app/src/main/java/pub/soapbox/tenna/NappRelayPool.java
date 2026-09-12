package pub.soapbox.tenna;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;

import okhttp3.OkHttpClient;

/**
 * Every relay the service is connected to, made to match a {@link NappPlan}.
 */
final class NappRelayPool {

    private final OkHttpClient client;
    private final ScheduledExecutorService scheduler;
    private final NappRelay.Listener listener;
    private final Map<String, NappRelay> relays = new HashMap<>();

    NappRelayPool(@NonNull OkHttpClient client, @NonNull ScheduledExecutorService scheduler, @NonNull NappRelay.Listener listener) {
        this.client = client;
        this.scheduler = scheduler;
        this.listener = listener;
    }

    /** Open, close and re-subscribe until the connected set is the planned one. */
    synchronized void apply(@NonNull NappPlan plan) {
        List<String> gone = new ArrayList<>();
        for (String url : relays.keySet()) {
            if (!plan.byRelay.containsKey(url)) gone.add(url);
        }
        for (String url : gone) {
            NappRelay relay = relays.remove(url);
            if (relay != null) relay.close();
        }

        for (Map.Entry<String, List<NappPlan.Subscription>> entry : plan.byRelay.entrySet()) {
            NappRelay relay = relays.get(entry.getKey());
            if (relay == null) {
                relay = new NappRelay(client, entry.getKey(), listener, scheduler);
                relays.put(entry.getKey(), relay);
            }
            relay.setSubscriptions(entry.getValue());
        }
    }

    /**
     * Send an event to every one of these relays that is currently up.
     *
     * <p>All of them rather than the first that works. A remote client listens
     * on the relays it named and there is no telling which of them it is
     * actually reading; kind 24133 is ephemeral, so an answer that went to the
     * wrong one of three is an answer that no longer exists anywhere.
     *
     * @return how many sockets took it.
     */
    synchronized int publish(@NonNull String eventJson, @NonNull List<String> urls) {
        int sent = 0;
        for (String url : urls) {
            NappRelay relay = relays.get(url);
            if (relay != null && relay.publish(eventJson)) sent++;
        }
        return sent;
    }

    synchronized void reconnectAll() {
        for (NappRelay relay : relays.values()) relay.reconnectNow();
    }

    synchronized void close() {
        for (NappRelay relay : relays.values()) relay.close();
        relays.clear();
    }
}
