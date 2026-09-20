package pub.soapbox.tenna;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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
 * <p>So the worker's provider is a {@code fetch} at its own origin, answered
 * here, and the same-origin request is what makes it safe to answer: the shim
 * carries the site's token, stamped into a worker script only that origin can
 * read, and {@link NappTokens} explains why a host in a URL is not proof on
 * its own.
 *
 * <p><b>Nothing is decided here.</b> Every question goes to
 * {@link TennaSigning}, which is the same code that answers a NIP-55 intent
 * and a NIP-46 request off a relay, against the same grants — so a site
 * allowed to decrypt in its window is allowed to decrypt in its worker, and
 * revoking it in settings revokes both. That is only true because those grants
 * live natively; see {@code nsitePermissions.ts} for the move that made it so.
 *
 * <h2>Why a call that needs approval is polled and not waited on</h2>
 *
 * <p>A request nobody has decided raises the signer notification, exactly as a
 * remote request does — see {@link NappBunker} — and then somebody has to walk
 * to their phone. The obvious shape is to block this thread until they do.
 *
 * <p>It is the wrong shape. This runs inside {@code shouldInterceptRequest} on
 * a thread Chromium owns and shares: every service worker in the process is
 * served from it, and every notification any site is trying to show is a fetch
 * that lands here. Holding it for a minute to wait on a person stalls every
 * other site in the app, including whatever the user is actually looking at.
 * A signing prompt that freezes the notifications of three unrelated sites is
 * a worse bug than the one it was solving.
 *
 * <p>So the call is parked, answered with {@code pending}, and the shim asks
 * again every second. Each of those returns at once. The request carries its
 * own deadline so that nobody walking to their phone leaves an entry in the
 * map and a notification in the shade forever.
 */
final class NsiteWorkerSigner {

    private static final String TAG = "NsiteWorkerSigner";

    /** Where a worker's {@code self.nostr} calls land. */
    static final String PATH = "/.napp/nostr";

    /** Query parameter naming the NIP-07 method, on a first call. */
    static final String METHOD_PARAM = "m";

    /** Query parameter carrying the base64url JSON arguments. */
    static final String PAYLOAD_PARAM = "p";

    /** Query parameter naming a parked call to ask about again. */
    static final String WAIT_PARAM = "w";

    /** Query parameter naming a parked call the worker has given up on. */
    static final String ABANDON_PARAM = "x";

    /**
     * How long a parked call is held.
     *
     * <p>Longer than the shim waits, on purpose: the worker gives up first and
     * says so, which takes the notification down at the same time. This is the
     * backstop for a worker that was killed mid-wait and will never say
     * anything again.
     */
    private static final long DEADLINE_MS = 150_000;

    /** An argument JSON longer than this is not one any honest caller sends. */
    private static final int MAX_PAYLOAD_BYTES = 512 * 1024;

    private NsiteWorkerSigner() {}

    // ── What is waiting on a person ──────────────────────────────────────────

    /**
     * A worker's call, parked while the user is asked about it.
     *
     * <p>It leaves the map three ways: the worker collects the answer, the
     * worker gives up, or it goes stale. Whichever happens, everything else
     * that reaches for it afterwards finds nothing and does nothing — which is
     * the property that lets the sheet and the worker race without either of
     * them having to know about the other.
     */
    static final class Pending {
        @NonNull final String requestId;
        @NonNull final String siteId;
        @NonNull final String siteName;
        @NonNull final String accountPubkey;
        @NonNull final TennaSigning.Request request;
        final long expiresAt;

        /**
         * Whether a sheet has taken this.
         *
         * <p>Two notifications cannot exist for one call, but a
         * {@code PendingIntent} can be fired twice, and answering one question
         * twice is one signature too many.
         */
        boolean claimed;

        @Nullable TennaSigning.Outcome outcome;

        Pending(
            @NonNull String requestId,
            @NonNull String siteId,
            @NonNull String siteName,
            @NonNull String accountPubkey,
            @NonNull TennaSigning.Request request
        ) {
            this.requestId = requestId;
            this.siteId = siteId;
            this.siteName = siteName;
            this.accountPubkey = accountPubkey;
            this.request = request;
            this.expiresAt = System.currentTimeMillis() + DEADLINE_MS;
        }
    }

    private static final Map<String, Pending> waiting = new HashMap<>();

    /**
     * Take a parked call for the sheet.
     *
     * <p>It stays in the map — the worker is still asking about it every
     * second — but only the first caller gets it.
     */
    @Nullable
    static Pending claim(@NonNull Context context, @NonNull String requestId) {
        Pending pending;
        List<String> stale;

        synchronized (waiting) {
            stale = expire();
            pending = waiting.get(requestId);
            if (pending != null && !pending.claimed && pending.outcome == null) {
                pending.claimed = true;
            } else {
                pending = null;
            }
        }

        cancelAll(context, stale);
        return pending;
    }

    /**
     * Hand a parked call its answer.
     *
     * <p>The worker collects it on its next ask. A call that has since expired
     * or been given up on is written to and never read, which is the right
     * outcome: the decision the user made is still recorded against the site,
     * so the next call is answered without asking again.
     */
    static void resolve(@NonNull Pending pending, @NonNull TennaSigning.Outcome outcome) {
        synchronized (waiting) {
            pending.outcome = outcome;
        }
    }

    /**
     * Drop parked calls nobody came back for, and say which they were.
     *
     * <p>Called holding the lock, and returns rather than cancelling so that
     * the binder call into the notification manager happens outside it.
     */
    @NonNull
    private static List<String> expire() {
        long now = System.currentTimeMillis();
        List<String> stale = new ArrayList<>();

        for (Map.Entry<String, Pending> entry : waiting.entrySet()) {
            if (now > entry.getValue().expiresAt) stale.add(entry.getKey());
        }
        for (String requestId : stale) waiting.remove(requestId);

        return stale;
    }

    /** Take down the notifications for calls nobody can answer any more. */
    private static void cancelAll(@NonNull Context context, @NonNull List<String> stale) {
        // A notification that opens a sheet with nothing in it is worse than
        // no notification.
        for (String requestId : stale) NappNotifications.cancelSignerRequest(context, requestId);
    }

    // ── Answering a call ─────────────────────────────────────────────────────

    /**
     * Answer one {@code self.nostr} request.
     *
     * <p>Always 200 with a JSON body — {@code result}, {@code error}, or
     * {@code pending} with an id to ask about again — so that the shim can
     * hand the site a real message rather than "failed to fetch". The caller
     * has already proved it is this site's own worker.
     */
    @NonNull
    static WebResourceResponse serve(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull Uri url
    ) {
        String waitId = query(url, WAIT_PARAM);
        if (waitId != null) return collect(context, siteId, waitId);

        String abandonId = query(url, ABANDON_PARAM);
        if (abandonId != null) return abandon(context, siteId, abandonId);

        return begin(context, siteId, url);
    }

    /** A call the worker has not made before. */
    @NonNull
    private static WebResourceResponse begin(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull Uri url
    ) {
        SignerTypes.Method method = methodOf(query(url, METHOD_PARAM));
        if (method == null) return error("Unrecognized method");

        JSONObject params = payload(query(url, PAYLOAD_PARAM));
        if (params == null) return error("Malformed arguments");

        String account = TennaAccounts.resolve(context, null);
        if (account == null) return error("Not logged in");

        // Who this is does not need the key and is not a question about it —
        // the same reasoning that has `TennaSigning.run` answer it from the
        // account list, and that lets a site's window embed the pubkey in its
        // injected provider without asking anybody.
        if (method == SignerTypes.Method.GET_PUBLIC_KEY) return result(account, null);

        TennaSigning.Request request = requestFrom(method, params);
        if (request == null) return error("Malformed arguments");

        // Waiting is allowed: this is a service worker fetch with nothing
        // drawn on it, and a signer app that answers in the background is what
        // lets a worker be answered with no window. It is a call into another
        // process rather than a wait on a person; see the class note on why
        // the second one is not done here.
        TennaSigning.Outcome outcome =
            TennaSigning.answer(context, account, siteId, request, true);

        if (outcome.status == TennaSigning.Outcome.Status.NEEDS_APPROVAL
            || outcome.status == TennaSigning.Outcome.Status.NEEDS_ACTIVITY) {
            return ask(context, siteId, account, request);
        }

        return answered(context, siteId, account, outcome);
    }

    /**
     * Put the question in front of the user, and tell the worker to ask again.
     *
     * <p>A notification, because there is no window to draw a sheet over — the
     * worker may be the only thing this app is running. The same notification
     * a remote request raises, opening the same sheet, because it is the same
     * question.
     */
    @NonNull
    private static WebResourceResponse ask(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String account,
        @NonNull TennaSigning.Request request
    ) {
        // Only here, with a person about to be asked. A call the user has
        // already answered costs them nothing however often it arrives; what
        // is worth stopping is a worker that can put an unbounded queue of
        // questions in front of somebody. See SignerRateLimiter.
        Integer kind = request.eventKind();
        String bucket = request.method.wire + (kind == null ? "" : ":" + kind);
        if (!SignerRateLimiter.allow(siteId, bucket)) {
            Log.i(TAG, "Refused a worker request that came too fast for " + siteId);
            return error("Too many requests");
        }

        String requestId = UUID.randomUUID().toString();
        Pending pending =
            new Pending(requestId, siteId, nameOf(context, siteId, account), account, request);

        List<String> stale;
        synchronized (waiting) {
            stale = expire();
            waiting.put(requestId, pending);
        }
        cancelAll(context, stale);

        if (!NappNotifications.showSignerRequest(
                context, requestId, pending.siteName, TennaSigning.describe(request),
                SignerActivity.siteIntent(context, requestId))) {
            // No way to ask, so no point holding the call. Said out loud
            // rather than left to time out: a worker told why can show
            // something, where a worker kept waiting can only stall.
            synchronized (waiting) {
                waiting.remove(requestId);
            }
            return error("Notifications are turned off for Tenna");
        }

        return pending(requestId);
    }

    /** The worker asking whether its parked call has been answered yet. */
    @NonNull
    private static WebResourceResponse collect(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String requestId
    ) {
        Pending pending;
        TennaSigning.Outcome outcome;
        List<String> stale;

        synchronized (waiting) {
            stale = expire();
            pending = waiting.get(requestId);

            // A site can only ask about its own. The token says which site is
            // asking; without this check it would say nothing about which
            // call, and one site could collect another's signature.
            if (pending != null && !pending.siteId.equals(siteId)) pending = null;

            outcome = pending == null ? null : pending.outcome;
            if (outcome != null) waiting.remove(requestId);
        }

        cancelAll(context, stale);

        if (pending == null) return error("That request is no longer waiting");
        if (outcome == null) return pending(requestId);

        NappNotifications.cancelSignerRequest(context, requestId);
        return answered(context, siteId, pending.accountPubkey, outcome);
    }

    /** The worker saying it has waited long enough. */
    @NonNull
    private static WebResourceResponse abandon(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String requestId
    ) {
        synchronized (waiting) {
            Pending pending = waiting.get(requestId);
            if (pending != null && pending.siteId.equals(siteId)) waiting.remove(requestId);
        }

        // Down whether or not there was anything to remove: a notification
        // whose worker has gone is one nobody can be answering.
        NappNotifications.cancelSignerRequest(context, requestId);
        return error("Timed out waiting for approval");
    }

    /** Turn an outcome into the answer the worker reads. */
    @NonNull
    private static WebResourceResponse answered(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String account,
        @NonNull TennaSigning.Outcome outcome
    ) {
        switch (outcome.status) {
            case RESULT:
                SignerApps.touch(context, account, siteId);
                return result(outcome.value == null ? "" : outcome.value, outcome.eventJson);

            case REJECTED:
                return error("User rejected");

            default:
                return error(outcome.error == null ? "Could not answer the request" : outcome.error);
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

    /** The call's arguments, or null if they were not a readable object. */
    @Nullable
    private static JSONObject payload(@Nullable String encoded) {
        if (encoded == null) return null;
        try {
            byte[] bytes = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            if (bytes.length > MAX_PAYLOAD_BYTES) return null;
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException | JSONException e) {
            return null;
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
     * A result.
     *
     * <p>For {@code signEvent} that is the whole signed event, because that is
     * what NIP-07 returns and what a site is going to publish; for everything
     * else it is the string the signer produced.
     */
    @NonNull
    private static WebResourceResponse result(@NonNull String value, @Nullable String eventJson) {
        JSONObject body = new JSONObject();
        try {
            if (eventJson != null) {
                body.put("result", new JSONObject(eventJson));
            } else {
                body.put("result", value);
            }
        } catch (JSONException e) {
            return error("Could not answer the request");
        }
        return json(body.toString());
    }

    /** Not yet. Ask again with {@value #WAIT_PARAM}. */
    @NonNull
    private static WebResourceResponse pending(@NonNull String requestId) {
        JSONObject body = new JSONObject();
        try {
            body.put("pending", requestId);
        } catch (JSONException e) {
            return error("Could not answer the request");
        }
        return json(body.toString());
    }

    @NonNull
    private static WebResourceResponse error(@NonNull String message) {
        JSONObject body = new JSONObject();
        try {
            body.put("error", message);
        } catch (JSONException e) {
            // A message that will not fit in a JSON string does not exist;
            // every one of them is a literal in this file.
        }
        return json(body.toString());
    }

    @NonNull
    private static WebResourceResponse json(@NonNull String source) {
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new NsiteFileServer.Response(
            200, "OK", "application/json", "UTF-8", headers,
            new ByteArrayInputStream(bytes), bytes.length
        ).toWebResource();
    }

    @Nullable
    private static String query(@NonNull Uri url, @NonNull String name) {
        try {
            return url.getQueryParameter(name);
        } catch (UnsupportedOperationException e) {
            return null;
        }
    }
}
