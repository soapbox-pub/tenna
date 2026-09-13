package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;

/**
 * A ceiling on how often one caller may put a question in front of the user.
 *
 * The approval sheet is a modal window that another application can raise at
 * will, which makes it a way to make the phone unusable — a loop of intents
 * puts a sheet on screen faster than anyone can dismiss it, over whatever they
 * were doing. Nothing about the signer's own correctness prevents that; it is
 * answering exactly the questions it was asked.
 *
 * <p>So each caller gets a small budget per half minute, counted separately
 * for each kind of question so that a client legitimately signing and
 * decrypting in the same moment does not spend one budget twice. A caller with
 * no package gets a smaller one: every web page looks the same from here, so
 * the budget is shared among all of them, and it is the one an attacker
 * reaches without having to install anything.
 *
 * <p><b>Counted only where a question would be asked.</b> A request the user
 * has already answered is not a question, however often it arrives, and an app
 * holding a grant can exercise it through the content resolver as fast as it
 * likes anyway — so refusing those buys nothing and costs an app doing a
 * legitimate burst of work its own permission. The budget is spent in {@link
 * SignerActivity}, at the point where something is about to go on screen, and
 * nowhere else.
 *
 * <p>The counter lives in memory and dies with the process, which is the right
 * lifetime — a user who force-stops the app has cleared the problem, and this
 * is not a security boundary that has to survive anything.
 */
final class SignerRateLimiter {

    private static final long WINDOW_MS = 30_000;

    /** Requests per window from an app the platform has named. */
    private static final int BUDGET_NAMED = 5;

    /**
     * Requests per window from a caller with no package.
     *
     * <p>Lower because it is shared. Every browser-borne request in the world
     * arrives under this one bucket, so the budget is not "per web page" — it
     * cannot be, since they are indistinguishable — and a page that needs more
     * than this in half a minute wants NIP-46 rather than this transport.
     */
    private static final int BUDGET_ANONYMOUS = 3;

    private static final Map<String, Deque<Long>> seen = new HashMap<>();

    private SignerRateLimiter() {}

    /**
     * Whether this request may proceed, counting it if so.
     *
     * <p>Not called for a request arriving at an activity that is already up:
     * a client sending a batch is the case this exists to allow, not the case
     * it exists to stop.
     */
    static synchronized boolean allow(@Nullable String requesterId, @NonNull String bucket) {
        boolean anonymous = requesterId == null || requesterId.isEmpty();
        String key = (anonymous ? "" : requesterId) + "\u0000" + bucket;
        long now = System.currentTimeMillis();

        Deque<Long> times = seen.get(key);
        if (times == null) {
            times = new ArrayDeque<>();
            seen.put(key, times);
        }

        while (!times.isEmpty() && now - times.peekFirst() > WINDOW_MS) {
            times.pollFirst();
        }

        if (times.size() >= (anonymous ? BUDGET_ANONYMOUS : BUDGET_NAMED)) return false;

        times.addLast(now);
        sweep(now);
        return true;
    }

    /**
     * Drop buckets nothing has used for a window.
     *
     * <p>Without it the map grows by one entry per calling app per kind of
     * question, forever. Small, but this is a process that is meant to stay
     * running for days.
     */
    private static void sweep(long now) {
        if (seen.size() < 64) return;
        seen.entrySet().removeIf(entry -> {
            Deque<Long> times = entry.getValue();
            return times.isEmpty() || now - times.peekLast() > WINDOW_MS;
        });
    }
}
