package pub.soapbox.tenna;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * {@code self.nostr} inside an nsite's service worker.
 *
 * <p>A site's window gets {@code window.nostr} from an injected script that
 * talks to the web layer — see {@code nsiteNostrProvider.ts}. A worker has no
 * window to inject into and no bridge to talk over, and the interesting case
 * is precisely the one where there is no window at all: a site woken by a push
 * wants to decrypt the message it was told about so it can say who it is from,
 * and the alternative is a notification reading "1 new message".
 *
 * <p>So the worker's provider is a call over the {@link NappPort} its host
 * handed it, and that is also what makes it safe to answer: a port is minted
 * on one site's WebView and transferred into that site's own worker, so the
 * thing holding it is the site, with nothing to prove on arrival.
 *
 * <p><b>Nothing is decided here.</b> Every question goes to
 * {@link TennaSigning}, which is the same code that answers a NIP-55 intent
 * and a NIP-46 request off a relay, against the same grants — so a site
 * allowed to decrypt in its window is allowed to decrypt in its worker, and
 * revoking it in settings revokes both. That is only true because those grants
 * live natively; see {@code nsitePermissions.ts} for the move that made it so.
 *
 * <h2>A call that needs approval simply waits</h2>
 *
 * <p>A request nobody has decided raises the signer notification, exactly as a
 * remote request does — see {@link NappBunker} — and then somebody has to walk
 * to their phone.
 *
 * <p>That used to be the awkward part. The call arrived as a {@code fetch} at
 * the site's origin, answered inside {@code shouldInterceptRequest} on a thread
 * Chromium owns and shares with every service worker in the process — so
 * holding it for a minute to wait on a person would have stalled every other
 * site in the app. The call was therefore parked, answered with
 * {@code pending}, and the worker asked again every second until somebody had
 * decided.
 *
 * <p>A port has no such thread. The question is asked, and the answer is sent
 * when there is one; the worker's promise settles then and asks nothing in
 * between. What is left of the old shape is the map — the sheet still resolves
 * a call from somewhere else entirely — and the deadline, which is the backstop
 * for a worker that was stopped mid-wait and will never collect anything.
 */
final class NsiteWorkerSigner {

    private static final String TAG = "NsiteWorkerSigner";

    /**
     * How long a call is held waiting on a person.
     *
     * <p>Nothing outside is counting any more, so this is a judgement about
     * what is worth keeping rather than a deadline imposed on us: past it the
     * notification is taken down and the worker is told, so that a question
     * nobody answered does not sit in the shade forever.
     */
    private static final long DEADLINE_MS = 150_000;

    /**
     * The clock the deadline is kept by.
     *
     * <p>The old road swept lazily, on the next call, which worked because the
     * worker was asking every second. Nothing asks now, so a call nobody
     * answers needs something of its own to end it.
     */
    private static final ScheduledExecutorService CLOCK =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "napp-signer-clock");
            thread.setDaemon(true);
            return thread;
        });

    private NsiteWorkerSigner() {}

    /** Where the answer to one call goes. Called exactly once, on any thread. */
    interface Answer {
        /** A string, or the whole signed event as a {@link JSONObject}. */
        void result(@NonNull Object value);

        void failed(@NonNull String reason);
    }

    // ── What is waiting on a person ──────────────────────────────────────────

    /**
     * A worker's call, held while the user is asked about it.
     *
     * <p>It leaves the map three ways: the sheet answers it, it goes stale, or
     * the site is forgotten. Whichever happens, everything else that reaches
     * for it afterwards finds nothing and does nothing — which is the property
     * that lets the sheet and the clock race without either of them having to
     * know about the other.
     */
    static final class Pending {
        @NonNull final String requestId;
        @NonNull final String siteId;
        @NonNull final String siteName;
        @NonNull final String accountPubkey;
        @NonNull final TennaSigning.Request request;

        /** Where the answer goes when there is one. */
        @NonNull final Answer answer;

        /** The application context, for the bookkeeping an answer does. */
        @NonNull final Context context;

        /**
         * Whether a sheet has taken this.
         *
         * <p>Two notifications cannot exist for one call, but a
         * {@code PendingIntent} can be fired twice, and answering one question
         * twice is one signature too many.
         */
        boolean claimed;

        /** Whether it has been answered, by anybody, by any road. */
        boolean settled;

        Pending(
            @NonNull Context context,
            @NonNull String requestId,
            @NonNull String siteId,
            @NonNull String siteName,
            @NonNull String accountPubkey,
            @NonNull TennaSigning.Request request,
            @NonNull Answer answer
        ) {
            this.context = context;
            this.requestId = requestId;
            this.siteId = siteId;
            this.siteName = siteName;
            this.accountPubkey = accountPubkey;
            this.request = request;
            this.answer = answer;
        }
    }

    private static final Map<String, Pending> waiting = new HashMap<>();

    /**
     * Take a held call for the sheet.
     *
     * <p>It stays in the map until it is answered — the thing waiting on it is
     * a promise in a worker, not a poll — but only the first caller gets it.
     */
    @Nullable
    static Pending claim(@NonNull Context context, @NonNull String requestId) {
        synchronized (waiting) {
            Pending pending = waiting.get(requestId);
            if (pending == null || pending.claimed || pending.settled) return null;
            pending.claimed = true;
            return pending;
        }
    }

    /**
     * Hand a held call its answer, and the worker with it.
     *
     * <p>A call that has since expired is written to and never read, which is
     * the right outcome: the decision the user made is still recorded against
     * the site, so the next call is answered without asking again.
     */
    static void resolve(@NonNull Pending pending, @NonNull TennaSigning.Outcome outcome) {
        synchronized (waiting) {
            if (pending.settled) return;
            pending.settled = true;
            waiting.remove(pending.requestId);
        }

        NappNotifications.cancelSignerRequest(pending.context, pending.requestId);
        answered(pending.context, pending.siteId, pending.accountPubkey, outcome, pending.answer);
    }

    /** Give up on one nobody answered. */
    private static void expire(@NonNull String requestId) {
        Pending pending;
        synchronized (waiting) {
            pending = waiting.get(requestId);
            if (pending == null || pending.settled) return;
            pending.settled = true;
            waiting.remove(requestId);
        }

        // A notification that opens a sheet with nothing in it is worse than
        // no notification.
        NappNotifications.cancelSignerRequest(pending.context, requestId);
        pending.answer.failed("Timed out waiting for approval");
    }

    /**
     * Give up on everything a site had out.
     *
     * <p>Its window is closing or it has been forgotten, so the worker that
     * asked is going too. Each is answered rather than dropped, on the chance
     * that something is still there to hear it.
     */
    static void forget(@NonNull String siteId) {
        List<Pending> theirs = new ArrayList<>();
        synchronized (waiting) {
            for (Pending pending : waiting.values()) {
                if (pending.siteId.equals(siteId)) theirs.add(pending);
            }
            for (Pending pending : theirs) {
                pending.settled = true;
                waiting.remove(pending.requestId);
            }
        }

        for (Pending pending : theirs) {
            NappNotifications.cancelSignerRequest(pending.context, pending.requestId);
            pending.answer.failed("The site went away");
        }
    }

    // ── Answering a call ─────────────────────────────────────────────────────

    /**
     * Answer one {@code self.nostr} call, whenever there is an answer.
     *
     * <p>Returns at once either way. Most calls are decided on the spot, from
     * a grant the site already has; one that is not raises a notification and
     * is answered when somebody has pressed something, which may be two minutes
     * from now. Nothing waits on a thread for it.
     *
     * <p>The caller has already established whose worker this is: it holds a
     * port that was transferred into that site's own registration. See
     * {@link NappPort}.
     */
    static void answer(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String methodName,
        @Nullable JSONObject params,
        @NonNull Answer answer
    ) {
        SignerTypes.Method method = methodOf(methodName);
        if (method == null) {
            answer.failed("Unrecognized method");
            return;
        }
        if (params == null) {
            answer.failed("Malformed arguments");
            return;
        }

        String account = TennaAccounts.resolve(context, null);
        if (account == null) {
            answer.failed("Not logged in");
            return;
        }

        // Who this is does not need the key and is not a question about it —
        // the same reasoning that has `TennaSigning.run` answer it from the
        // account list, and that lets a site's window embed the pubkey in its
        // injected provider without asking anybody.
        if (method == SignerTypes.Method.GET_PUBLIC_KEY) {
            answer.result(account);
            return;
        }

        TennaSigning.Request request = requestFrom(method, params);
        if (request == null) {
            answer.failed("Malformed arguments");
            return;
        }

        // Waiting is allowed: this is a thread of Tenna's, and a signer app
        // that answers in the background is what lets a worker be answered
        // with no window.
        TennaSigning.Outcome outcome =
            TennaSigning.answer(context, account, siteId, request, true);

        if (outcome.status == TennaSigning.Outcome.Status.NEEDS_APPROVAL
            || outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
            ask(context, siteId, account, request, answer);
            return;
        }

        answered(context, siteId, account, outcome, answer);
    }

    /**
     * Put the question in front of the user, and hold the call until they
     * answer it.
     *
     * <p>A notification, because there is no window to draw a sheet over — the
     * worker may be the only thing this app is running. The same notification
     * a remote request raises, opening the same sheet, because it is the same
     * question.
     */
    private static void ask(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String account,
        @NonNull TennaSigning.Request request,
        @NonNull Answer answer
    ) {
        // Only here, with a person about to be asked. A call the user has
        // already answered costs them nothing however often it arrives; what
        // is worth stopping is a worker that can put an unbounded queue of
        // questions in front of somebody. See SignerRateLimiter.
        Integer kind = request.eventKind();
        String bucket = request.method.wire + (kind == null ? "" : ":" + kind);
        if (!SignerRateLimiter.allow(siteId, bucket)) {
            Log.i(TAG, "Refused a worker request that came too fast for " + siteId);
            answer.failed("Too many requests");
            return;
        }

        String requestId = UUID.randomUUID().toString();
        Pending pending = new Pending(
            context.getApplicationContext(),
            requestId,
            siteId,
            nameOf(context, siteId, account),
            account,
            request,
            answer
        );

        synchronized (waiting) {
            waiting.put(requestId, pending);
        }

        if (!NappNotifications.showSignerRequest(
                context, requestId, pending.siteName, TennaSigning.describe(request),
                SignerActivity.siteIntent(context, requestId))) {
            // No way to ask, so no point holding the call. Said out loud
            // rather than left to time out: a worker told why can show
            // something, where a worker kept waiting can only stall.
            synchronized (waiting) {
                pending.settled = true;
                waiting.remove(requestId);
            }
            answer.failed("Notifications are turned off for Tenna");
            return;
        }

        CLOCK.schedule(() -> expire(requestId), DEADLINE_MS, TimeUnit.MILLISECONDS);
    }

    /** Turn an outcome into the answer the worker gets. */
    private static void answered(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String account,
        @NonNull TennaSigning.Outcome outcome,
        @NonNull Answer answer
    ) {
        switch (outcome.status) {
            case RESULT:
                SignerApps.touch(context, account, siteId);
                answer.result(result(outcome.value == null ? "" : outcome.value, outcome.eventJson));
                break;

            case REJECTED:
                answer.failed("User rejected");
                break;

            default:
                answer.failed(
                    outcome.error == null ? "Could not answer the request" : outcome.error);
                break;
        }
    }

    /**
     * What to call the site in a notification.
     *
     * <p>Every name this side has for a site, in the order of how well the
     * user knows it: one they have already answered a prompt for, one they
     * pinned to the home screen, one they turned notifications on for. Failing
     * all three, the subdomain — which is not friendly, and is at least the
     * site and not a guess at it.
     */
    @NonNull
    private static String nameOf(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String account
    ) {
        SignerApps.Record granted = SignerApps.get(context, account, siteId);
        if (granted != null && !granted.name.isEmpty()) return granted.name;

        NsiteSites.Record pinned = NsiteSites.load(context, siteId);
        if (pinned != null && pinned.label != null && !pinned.label.isEmpty()) return pinned.label;

        NappSubscriptions.Record subscribed = NappSubscriptions.get(context, siteId);
        if (subscribed != null && !subscribed.label.isEmpty()) return subscribed.label;

        return siteId;
    }

    // ── Reading the call ─────────────────────────────────────────────────────

    /**
     * The signer method a NIP-07 name stands for.
     *
     * <p>Spelled the way the web spells it, because the worker's provider is
     * the NIP-07 interface and a site should not have to learn a second
     * vocabulary to use it from a worker.
     */
    @Nullable
    private static SignerTypes.Method methodOf(@Nullable String name) {
        if (name == null) return null;
        switch (name) {
            case "getPublicKey": return SignerTypes.Method.GET_PUBLIC_KEY;
            case "signEvent": return SignerTypes.Method.SIGN_EVENT;
            case "nip04.encrypt": return SignerTypes.Method.NIP04_ENCRYPT;
            case "nip04.decrypt": return SignerTypes.Method.NIP04_DECRYPT;
            case "nip44.encrypt": return SignerTypes.Method.NIP44_ENCRYPT;
            case "nip44.decrypt": return SignerTypes.Method.NIP44_DECRYPT;
            default: return null;
        }
    }

    /** The normalised question, or null if the arguments do not make one. */
    @Nullable
    private static TennaSigning.Request requestFrom(
        @NonNull SignerTypes.Method method,
        @NonNull JSONObject params
    ) {
        if (method == SignerTypes.Method.SIGN_EVENT) {
            JSONObject event = params.optJSONObject("event");
            if (event == null || !event.has("kind")) return null;
            return new TennaSigning.Request(method, event.toString(), null);
        }

        String peer = params.optString("pubkey", "");
        String text = params.optString("text", "");
        if (peer.length() != 64) return null;
        return new TennaSigning.Request(method, text, peer);
    }

    // ── Writing the answer ───────────────────────────────────────────────────

    /**
     * A result, in the shape the worker's promise resolves to.
     *
     * <p>For {@code signEvent} that is the whole signed event, because that is
     * what NIP-07 returns and what a site is going to publish; for everything
     * else it is the string the signer produced.
     */
    @NonNull
    private static Object result(@NonNull String value, @Nullable String eventJson) {
        if (eventJson == null) return value;
        try {
            return new JSONObject(eventJson);
        } catch (JSONException e) {
            // A signed event this side built and could not read back. Handing
            // over the text is better than handing over nothing.
            return eventJson;
        }
    }
}
