package pub.soapbox.tenna;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Answering a client that is not on this phone.
 *
 * NIP-46 is the same questions as NIP-55 arriving by a different road. A
 * request is a kind 24133 event addressed to a connection's key, encrypted to
 * it; the answer is another one going back the other way. Everything between
 * those two steps — which account, whether this client may, what the answer is
 * — is {@link TennaSigning}, exactly as it is for an app on the phone. The
 * only thing particular to this file is the envelope.
 *
 * <p>It runs inside {@link NappPushService}, on the relay sockets that service
 * already holds open for site notifications. That is the whole reason a remote
 * signer is possible at all: something has to be listening while the app is
 * closed, and rather than a second service with a second notification there is
 * one, saying what it is doing.
 *
 * <p><b>Every incoming event is verified.</b> Unlike a site's notifications,
 * where a forged event costs a wrong line in the shade and the site's own code
 * decides what to believe, this path takes instructions. An unverified event
 * here would let any relay tell Tenna it had been asked to sign something.
 *
 * <p>What cannot be answered from a standing grant raises a notification and
 * waits. Nothing is auto-approved and nothing is queued to disk: kind 24133 is
 * ephemeral, so a request that outlives the process was never recoverable
 * anyway, and pretending otherwise would mean answering an hour later a
 * question the client stopped waiting for.
 */
final class NappBunker {

    private static final String TAG = "NappBunker";

    /** NIP-46's one kind, in both directions. */
    static final int KIND = 24133;

    /** How long a request nobody answered stays worth answering. */
    private static final long PENDING_TTL_MS = 5 * 60_000;

    /** At most this many unanswered requests, oldest dropped. */
    private static final int MAX_PENDING = 16;

    private NappBunker() {}

    // ── Requests waiting on the user ─────────────────────────────────────────

    /** A request that needs somebody to look at it. */
    static final class Pending {
        @NonNull final String requestId;
        @NonNull final String localPubkey;
        @NonNull final String clientPubkey;
        @NonNull final String accountPubkey;
        @NonNull final String appName;
        @NonNull final TennaSigning.Request request;
        final boolean nip04;
        @NonNull final List<String> relays;
        final long at;

        Pending(@NonNull String requestId, @NonNull String localPubkey, @NonNull String clientPubkey,
                @NonNull String accountPubkey, @NonNull String appName,
                @NonNull TennaSigning.Request request, boolean nip04, @NonNull List<String> relays) {
            this.requestId = requestId;
            this.localPubkey = localPubkey;
            this.clientPubkey = clientPubkey;
            this.accountPubkey = accountPubkey;
            this.appName = appName;
            this.request = request;
            this.nip04 = nip04;
            this.relays = relays;
            this.at = System.currentTimeMillis();
        }
    }

    /**
     * Unanswered requests, in memory and nowhere else.
     *
     * Process-lifetime on purpose — see the note on the class. Keyed by the
     * client's own request id, which is what the answer has to quote.
     */
    private static final Map<String, Pending> pending = new LinkedHashMap<>();

    /** The requests a person could still usefully answer, newest last. */
    @NonNull
    static synchronized List<Pending> waiting() {
        sweep();
        return new ArrayList<>(pending.values());
    }

    @Nullable
    static synchronized Pending take(@NonNull String requestId) {
        sweep();
        return pending.remove(requestId);
    }

    static synchronized int waitingCount() {
        sweep();
        return pending.size();
    }

    private static synchronized void remember(@NonNull Pending request) {
        sweep();
        pending.put(request.requestId, request);
        while (pending.size() > MAX_PENDING) {
            String oldest = pending.keySet().iterator().next();
            pending.remove(oldest);
        }
    }

    private static void sweep() {
        long now = System.currentTimeMillis();
        pending.values().removeIf(entry -> now - entry.at > PENDING_TTL_MS);
    }

    // ── A decision on its way to the service ─────────────────────────────────

    /** A request the user has answered, waiting for a socket to say so on. */
    static final class Staged {
        @NonNull final Pending request;
        final boolean allowed;
        final boolean remember;
        /**
         * The answer, when whoever asked the user also did the work.
         *
         * <p>Set when the signer behind the account had to be asked in a
         * window — the sheet has one and the service has not, so the result
         * comes back with the decision rather than being recomputed here,
         * which would mean asking that signer a second time.
         */
        @Nullable final TennaSigning.Outcome outcome;

        Staged(@NonNull Pending request, boolean allowed, boolean remember,
               @Nullable TennaSigning.Outcome outcome) {
            this.request = request;
            this.allowed = allowed;
            this.remember = remember;
            this.outcome = outcome;
        }
    }

    /**
     * Answers handed over by the sheet, waiting for the service to send them.
     *
     * <p>The sheet is an activity and the relay socket belongs to the service,
     * and the two are not the same process moment: the service may not even be
     * running when somebody taps a notification after a reboot. So the decision
     * is left here and the service is started, which is also what reconnects
     * the socket it will need.
     */
    private static final Map<String, Staged> staged = new LinkedHashMap<>();

    static synchronized void stage(@NonNull Pending request, boolean allowed, boolean remember,
                                   @Nullable TennaSigning.Outcome outcome) {
        staged.put(request.requestId, new Staged(request, allowed, remember, outcome));
    }

    @Nullable
    static synchronized Staged unstage(@Nullable String requestId) {
        return requestId == null ? null : staged.remove(requestId);
    }

    // ── Receiving ────────────────────────────────────────────────────────────

    /**
     * A kind 24133 arrived for one of our connections.
     *
     * <p>Called on an OkHttp thread. Everything here is quick except the
     * publish at the end, which is a socket write.
     */
    static void receive(
        @NonNull Context context,
        @NonNull Publisher publisher,
        @NonNull String localPubkey,
        @NonNull JSONObject event
    ) {
        if (event.optInt("kind", 0) != KIND) return;

        String clientPubkey = event.optString("pubkey", "");
        if (clientPubkey.length() != 64) return;

        // A relay handing us an event it made up would otherwise be a relay
        // telling us we had been asked to sign something.
        if (!verify(event)) {
            Log.w(TAG, "Dropped a request that was not signed by who it claims");
            return;
        }

        BunkerConnections.Connection connection =
            BunkerConnections.byLocalPubkey(context, localPubkey);
        if (connection == null) return;

        byte[] key = connection.key();
        if (key == null) {
            Log.w(TAG, "A connection's key will not open; leaving it alone");
            return;
        }

        String ciphertext = event.optString("content", "");
        boolean nip04 = looksLikeNip04(ciphertext);
        String plaintext = decrypt(key, clientPubkey, ciphertext, nip04);
        if (plaintext == null) {
            Log.i(TAG, "Could not read a request from " + TennaAccounts.shorten(clientPubkey));
            return;
        }

        try {
            handle(context, publisher, connection, clientPubkey, new JSONObject(plaintext), nip04);
        } catch (JSONException e) {
            Log.i(TAG, "A request was not a request");
        }
    }

    /** What a parsed request means, and what goes back. */
    private static void handle(
        @NonNull Context context,
        @NonNull Publisher publisher,
        @NonNull BunkerConnections.Connection connection,
        @NonNull String clientPubkey,
        @NonNull JSONObject message,
        boolean nip04
    ) {
        String requestId = message.optString("id", "");
        String methodName = message.optString("method", "");
        JSONArray params = message.optJSONArray("params");
        if (params == null) params = new JSONArray();
        if (requestId.isEmpty()) return;

        Log.i(TAG, "A remote app asked for " + methodName);

        SignerTypes.Method method = SignerTypes.fromWire(methodName);

        // Never silence. A client waiting on an answer it will not get is a
        // client that hangs, and "I do not know that word" is an answer.
        if (method == null) {
            reply(publisher, connection, clientPubkey, requestId, null,
                "Unrecognized method: " + methodName, nip04);
            return;
        }

        switch (method) {
            case CONNECT:
                connect(context, publisher, connection, clientPubkey, requestId, params, nip04);
                return;

            case SWITCH_RELAYS: {
                // The signer is meant to stay in charge of where it is
                // reached. Ours does not move, so it says so.
                reply(publisher, connection, clientPubkey, requestId, "null", null, nip04);
                return;
            }

            case LOGOUT: {
                reply(publisher, connection, clientPubkey, requestId, "ack", null, nip04);
                BunkerConnections.forget(context, connection.localPubkey);
                Log.i(TAG, "A remote app said it was done; its connection is gone");
                return;
            }

            default:
                break;
        }

        // Anything past here is a use of the connection, and a connection has
        // to exist before it can be used.
        if (!connection.connected || !connection.clientPubkey.equals(clientPubkey)) {
            reply(publisher, connection, clientPubkey, requestId, null, "no permission", nip04);
            return;
        }

        TennaSigning.Request request = requestFrom(method, params);
        if (request == null) {
            reply(publisher, connection, clientPubkey, requestId, null,
                "Malformed params for " + methodName, nip04);
            return;
        }

        String account = TennaSigning.accountFor(context, connection.accountPubkey, request);
        if (account == null) {
            reply(publisher, connection, clientPubkey, requestId, null,
                "no key for that account", nip04);
            return;
        }

        TennaSigning.Outcome outcome =
            TennaSigning.answer(context, account, clientPubkey, request);

        switch (outcome.status) {
            case RESULT:
                BunkerConnections.save(context, connection.used());
                SignerApps.touch(context, account, clientPubkey);
                reply(publisher, connection, clientPubkey, requestId, resultFor(method, outcome), null, nip04);
                return;

            case REJECTED:
                reply(publisher, connection, clientPubkey, requestId, null, "user rejected", nip04);
                return;

            case ERROR:
                reply(publisher, connection, clientPubkey, requestId, null,
                    outcome.error == null ? "could not answer" : outcome.error, nip04);
                return;

            default: {
                // Either nobody has decided, or the signer behind this account
                // has to be asked in a window — and a relay socket has not got
                // one. Both end up in the same place: on screen, which from
                // here means a notification, because the app is closed.
                Pending waiting = new Pending(requestId, connection.localPubkey, clientPubkey,
                    account, connection.displayName(), request, nip04, connection.relays);

                if (!NappNotifications.showSignerRequest(context, requestId,
                        connection.displayName(), TennaSigning.describe(request))) {
                    // Notifications are off, so there is no way to ask and no
                    // point holding the request. Said out loud rather than left
                    // to time out: a client told why can say so to whoever is
                    // using it, where a client kept waiting can only hang.
                    Log.i(TAG, "Could not ask about a remote request; notifications are off");
                    reply(publisher, connection, clientPubkey, requestId, null,
                        "cannot ask the user: notifications are turned off for Tenna", nip04);
                    return;
                }

                remember(waiting);
            }
        }
    }

    /**
     * A client asking to be let in.
     *
     * <p>The secret is what proves this is the client the user made the
     * invitation for. A {@code nostrconnect://} connection was made with the
     * client already named, so it is already bound and this is a formality;
     * a {@code bunker://} one is bound here, once, by whoever quotes it first.
     */
    private static void connect(
        @NonNull Context context,
        @NonNull Publisher publisher,
        @NonNull BunkerConnections.Connection connection,
        @NonNull String clientPubkey,
        @NonNull String requestId,
        @NonNull JSONArray params,
        boolean nip04
    ) {
        if (connection.connected && connection.clientPubkey.equals(clientPubkey)) {
            reply(publisher, connection, clientPubkey, requestId,
                connection.secret.isEmpty() ? "ack" : connection.secret, null, nip04);
            return;
        }

        if (connection.connected) {
            reply(publisher, connection, clientPubkey, requestId, null, "already connected", nip04);
            return;
        }

        // params are [remote-signer-pubkey, secret, perms, metadata]
        String offered = params.optString(1, "");
        if (connection.secret.isEmpty() || !connection.secret.equals(offered)) {
            reply(publisher, connection, clientPubkey, requestId, null, "invalid secret", nip04);
            return;
        }

        String name = "", url = "", image = "";
        JSONObject metadata = metadata(params.optString(3, ""));
        if (metadata != null) {
            name = metadata.optString("name", "");
            url = metadata.optString("url", "");
            image = metadata.optString("image", "");
        }

        BunkerConnections.Connection bound =
            connection.bound(clientPubkey, connection.relays, name, url, image);
        BunkerConnections.save(context, bound);

        // What the user agreed to when they made the invitation, written down
        // now that there is a client to write it against. Asking to be
        // identified and answering a ping are the two things a connection
        // cannot work without, so they come with it.
        grantRequested(context, bound, clientPubkey, params.optString(2, ""));

        Log.i(TAG, "A remote app connected");
        reply(publisher, bound, clientPubkey, requestId,
            bound.secret.isEmpty() ? "ack" : bound.secret, null, nip04);
    }

    /** Write down the permissions the invitation was made with. */
    private static void grantRequested(
        @NonNull Context context,
        @NonNull BunkerConnections.Connection connection,
        @NonNull String clientPubkey,
        @NonNull String perms
    ) {
        SignerApps.grant(context, connection.accountPubkey, clientPubkey,
            SignerApps.KIND_BUNKER, connection.displayName(),
            SignerTypes.PERM_GET_PUBLIC_KEY, null, true);
        SignerApps.grant(context, connection.accountPubkey, clientPubkey,
            SignerApps.KIND_BUNKER, connection.displayName(),
            SignerTypes.PERM_PING, null, true);

        for (String perm : perms.split(",")) {
            Integer[] kind = new Integer[1];
            String permission = SignerTypes.permissionFromPerm(perm, kind);
            if (permission == null) continue;
            SignerApps.grant(context, connection.accountPubkey, clientPubkey,
                SignerApps.KIND_BUNKER, connection.displayName(), permission, kind[0], true);
        }
    }

    @Nullable
    private static JSONObject metadata(@NonNull String json) {
        if (json.isEmpty()) return null;
        try {
            return new JSONObject(json);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Turn NIP-46's positional params into the shape everything else uses. */
    @Nullable
    static TennaSigning.Request requestFrom(
        @NonNull SignerTypes.Method method,
        @NonNull JSONArray params
    ) {
        switch (method) {
            case GET_PUBLIC_KEY:
            case PING:
                return new TennaSigning.Request(method, "", null);

            case SIGN_EVENT: {
                String event = params.optString(0, "");
                return event.isEmpty() ? null : new TennaSigning.Request(method, event, null);
            }

            case DECRYPT_ZAP_EVENT: {
                String event = params.optString(0, "");
                return event.isEmpty() ? null : new TennaSigning.Request(method, event, null);
            }

            default: {
                // [third-party pubkey, payload]
                String peer = params.optString(0, "");
                String payload = params.optString(1, "");
                if (peer.length() != 64) return null;
                return new TennaSigning.Request(method, payload, peer);
            }
        }
    }

    /** What goes in the {@code result} field for each method. */
    @NonNull
    static String resultFor(@NonNull SignerTypes.Method method, @NonNull TennaSigning.Outcome outcome) {
        // NIP-46 wants the whole signed event back, where NIP-55 wants the
        // signature; the rest are the same string either way.
        if (method == SignerTypes.Method.SIGN_EVENT && outcome.eventJson != null) {
            return outcome.eventJson;
        }
        return outcome.value == null ? "" : outcome.value;
    }

    // ── Answering ────────────────────────────────────────────────────────────

    /** Somebody pressed a button on a request that was waiting. */
    static void resolve(
        @NonNull Context context,
        @NonNull Publisher publisher,
        @NonNull Pending request,
        boolean allowed,
        boolean remember,
        @Nullable TennaSigning.Outcome answered
    ) {
        BunkerConnections.Connection connection =
            BunkerConnections.byLocalPubkey(context, request.localPubkey);
        if (connection == null) return;

        String permission = request.request.method.permission;
        if (remember && permission != null) {
            SignerApps.grant(context, request.accountPubkey, request.clientPubkey,
                SignerApps.KIND_BUNKER, connection.displayName(),
                permission, request.request.eventKind(), allowed);
        }

        if (!allowed) {
            reply(publisher, connection, request.clientPubkey, request.requestId,
                null, "user rejected", request.nip04);
            return;
        }

        // The work, unless whoever asked the user already did it. Doing it
        // again would mean putting the same question to the account's own
        // signer twice.
        TennaSigning.Outcome outcome = answered != null
            ? answered
            : TennaSigning.run(context, request.accountPubkey, request.request);

        if (outcome.isResult()) {
            BunkerConnections.save(context, connection.used());
            SignerApps.touch(context, request.accountPubkey, request.clientPubkey);
            reply(publisher, connection, request.clientPubkey, request.requestId,
                resultFor(request.request.method, outcome), null, request.nip04);
        } else {
            reply(publisher, connection, request.clientPubkey, request.requestId, null,
                outcome.error == null ? "could not answer" : outcome.error, request.nip04);
        }
    }

    /** Where a reply can be sent. */
    interface Publisher {
        /** Publish this event on these relays. May be called off the main thread. */
        void publish(@NonNull String eventJson, @NonNull List<String> relays);
    }

    /**
     * Build, encrypt, sign and send one response.
     *
     * <p>Encrypted the way the request was. There is no negotiation in NIP-46
     * and no per-connection setting: a client that spoke NIP-04 is answered in
     * NIP-04, because that is the only evidence there is about what it can
     * read.
     */
    private static void reply(
        @NonNull Publisher publisher,
        @NonNull BunkerConnections.Connection connection,
        @NonNull String clientPubkey,
        @NonNull String requestId,
        @Nullable String result,
        @Nullable String error,
        boolean nip04
    ) {
        byte[] key = connection.key();
        if (key == null) return;

        try {
            JSONObject body = new JSONObject();
            body.put("id", requestId);
            body.put("result", result == null ? "" : result);
            if (error != null) body.put("error", error);

            String ciphertext = encrypt(key, clientPubkey, body.toString(), nip04);
            if (ciphertext == null) return;

            JSONArray tags = new JSONArray()
                .put(new JSONArray().put("p").put(clientPubkey));

            JSONObject event = NostrCrypto.finalizeEvent(
                KIND, ciphertext, tags, System.currentTimeMillis() / 1000, key);

            publisher.publish(event.toString(), connection.relays);
        } catch (Exception e) {
            Log.w(TAG, "Could not answer a remote request", e);
        }
    }

    // ── Answering a client that invited us ───────────────────────────────────

    /**
     * The connect response a {@code nostrconnect://} client is waiting for.
     *
     * <p>The client made the invitation, so there is no request to answer —
     * it is listening for an unsolicited response quoting the secret it chose,
     * which is how it learns both that it was accepted and which key accepted
     * it. NIP-46 gives it no request id, so the secret goes in the {@code id}
     * field too, which is what clients match on.
     *
     * <p>NIP-44, always. A client that publishes a {@code nostrconnect://}
     * string is a current one, and there is no earlier message from it to
     * infer anything else from.
     *
     * @return the event as JSON, or null if it could not be built.
     */
    @Nullable
    static String connectResponse(@NonNull BunkerConnections.Connection connection) {
        byte[] key = connection.key();
        if (key == null) return null;

        try {
            JSONObject body = new JSONObject();
            body.put("id", connection.secret);
            body.put("result", connection.secret);

            String ciphertext = encrypt(key, connection.clientPubkey, body.toString(), false);
            if (ciphertext == null) return null;

            JSONArray tags = new JSONArray()
                .put(new JSONArray().put("p").put(connection.clientPubkey));

            return NostrCrypto.finalizeEvent(
                KIND, ciphertext, tags, System.currentTimeMillis() / 1000, key).toString();
        } catch (Exception e) {
            Log.w(TAG, "Could not build a connect response", e);
            return null;
        }
    }

    // ── Crypto ───────────────────────────────────────────────────────────────

    /**
     * Whether this ciphertext is NIP-04.
     *
     * <p>Its wire format ends in {@code ?iv=}, which NIP-44's base64 blob
     * cannot contain. Sniffing is what every implementation does; there is no
     * version marker outside the payload.
     */
    private static boolean looksLikeNip04(@NonNull String ciphertext) {
        return ciphertext.contains("?iv=");
    }

    @Nullable
    private static String decrypt(byte[] key, String peer, String ciphertext, boolean nip04) {
        return nip04
            ? NostrCipher.decrypt04(NostrCrypto.sharedSecret(key, peer), ciphertext)
            : NostrCipher.decrypt44(NostrCrypto.conversationKey(key, peer), ciphertext);
    }

    @Nullable
    private static String encrypt(byte[] key, String peer, String plaintext, boolean nip04) {
        return nip04
            ? NostrCipher.encrypt04(NostrCrypto.sharedSecret(key, peer), plaintext)
            : NostrCipher.encrypt44(NostrCrypto.conversationKey(key, peer), plaintext);
    }

    /** Whether the event's id and signature are its own. */
    private static boolean verify(@NonNull JSONObject event) {
        try {
            String pubkey = event.optString("pubkey", "");
            String id = event.optString("id", "");
            String sig = event.optString("sig", "");
            JSONArray tags = event.optJSONArray("tags");
            if (tags == null) tags = new JSONArray();

            String computed = NostrCrypto.eventId(
                pubkey, event.optLong("created_at", 0), event.optInt("kind", -1),
                tags, event.optString("content", ""));
            if (!computed.equals(id)) return false;

            return NostrCrypto.schnorrVerify(
                NostrCipher.hexToBytes(id),
                NostrCipher.hexToBytes(pubkey),
                NostrCipher.hexToBytes(sig));
        } catch (Exception e) {
            return false;
        }
    }
}
