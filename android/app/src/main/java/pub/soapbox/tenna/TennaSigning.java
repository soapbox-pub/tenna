package pub.soapbox.tenna;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The one place a request from another application is answered.
 *
 * Three transports reach this class and none of them decide anything. A NIP-55
 * intent, a content resolver query, and a NIP-46 request off a relay are three
 * spellings of the same question, and the policy that answers them — which
 * account, whether this caller may, what the answer is — has to be one piece of
 * code or it is three subtly different policies that drift apart.
 *
 * <p>The shape that makes that work is {@link Outcome}, and specifically that
 * it has three outcomes rather than two. "No" and "not yet" are different
 * answers: a caller told no should stop asking, and a caller told not yet
 * should put the question in front of the user. The content resolver needs
 * exactly that distinction to satisfy NIP-55 — a rejected column means give
 * up, a null cursor means try the intent — and once it exists, the intent path
 * gets to use it to decide whether to draw anything at all, and the relay path
 * gets to use it to decide whether to raise a notification. All three get the
 * behaviour right because none of them work it out themselves.
 *
 * <p>Nothing here draws, prompts, or waits. {@link #answer} either has the
 * answer already or says it does not; showing the user a question is the
 * caller's job, and {@link #run} is what it calls afterwards if the user says
 * yes. That split is why a remembered grant costs no WebView: the activity can
 * ask this class, get a result, and finish without ever having booted one.
 */
final class TennaSigning {

    private static final String TAG = "TennaSigning";

    private TennaSigning() {}

    // ── What was asked ───────────────────────────────────────────────────────

    /** A question, in the normalised form all three transports arrive at. */
    static final class Request {
        @NonNull final SignerTypes.Method method;
        /** The event JSON, plaintext, or ciphertext. Empty for questions with no payload. */
        @NonNull final String payload;
        /** The other party's pubkey, for encryption and decryption. */
        @Nullable final String peer;

        Request(@NonNull SignerTypes.Method method, @NonNull String payload, @Nullable String peer) {
            this.method = method;
            this.payload = payload;
            this.peer = peer;
        }

        /**
         * The kind of event this would sign, or null.
         *
         * <p>What makes a signing grant specific. An app allowed to sign a
         * reaction has not been allowed to sign a note, and the kind is the
         * only thing in the request that says which is which.
         */
        @Nullable
        Integer eventKind() {
            if (method != SignerTypes.Method.SIGN_EVENT) return null;
            try {
                return new JSONObject(payload).getInt("kind");
            } catch (Exception e) {
                return null;
            }
        }

        /**
         * The pubkey the event names as its author, or null.
         *
         * <p>A client with several accounts may say which one it means here
         * rather than in {@code current_user}, and the two can disagree.
         */
        @Nullable
        String eventAuthor() {
            if (method != SignerTypes.Method.SIGN_EVENT) return null;
            try {
                String pubkey = new JSONObject(payload).optString("pubkey", "");
                return pubkey.length() == 64 ? pubkey : null;
            } catch (Exception e) {
                return null;
            }
        }
    }

    // ── What came back ───────────────────────────────────────────────────────

    /** An answer, or the reason there isn't one yet. */
    static final class Outcome {
        enum Status {
            /** Answered. {@link #value} is the result. */
            RESULT,
            /** The user has said no to this before. Do not ask again. */
            REJECTED,
            /** Nobody has decided. Put it in front of the user. */
            NEEDS_APPROVAL,
            /**
             * Allowed, and the signer behind this account has to be asked in a
             * window — which this caller has not got.
             *
             * <p>Distinct from {@link #NEEDS_APPROVAL} because the user has
             * already said yes: what is missing is an activity to launch the
             * other signer from, not a decision. A caller with one carries on;
             * a caller without one degrades the way its transport says to.
             */
            NEEDS_ACTIVITY,
            /** The request could not be answered at all. {@link #error} says why. */
            ERROR,
        }

        @NonNull final Status status;
        @Nullable final String value;
        /** The whole signed event, for {@code sign_event}. */
        @Nullable final String eventJson;
        @Nullable final String error;

        private Outcome(@NonNull Status status, @Nullable String value,
                        @Nullable String eventJson, @Nullable String error) {
            this.status = status;
            this.value = value;
            this.eventJson = eventJson;
            this.error = error;
        }

        static Outcome result(@NonNull String value) {
            return new Outcome(Status.RESULT, value, null, null);
        }

        static Outcome signed(@NonNull String signature, @NonNull String eventJson) {
            return new Outcome(Status.RESULT, signature, eventJson, null);
        }

        static Outcome rejected() {
            return new Outcome(Status.REJECTED, null, null, null);
        }

        static Outcome needsApproval() {
            return new Outcome(Status.NEEDS_APPROVAL, null, null, null);
        }

        static Outcome needsActivity() {
            return new Outcome(Status.NEEDS_ACTIVITY, null, null, null);
        }

        static Outcome error(@NonNull String message) {
            return new Outcome(Status.ERROR, null, null, message);
        }

        boolean isResult() {
            return status == Status.RESULT;
        }
    }

    /**
     * One line saying what was asked, for a notification.
     *
     * <p>Deliberately thin. A notification about a signing request is seen on
     * a lock screen by whoever is holding the phone, so it says the shape of
     * the request and never its contents — the event body is for the sheet,
     * which at least required getting that far.
     */
    @NonNull
    static String describe(@NonNull Request request) {
        switch (request.method) {
            case SIGN_EVENT: {
                Integer kind = request.eventKind();
                return kind == null ? "wants to sign an event" : "wants to sign a kind " + kind + " event";
            }
            case GET_PUBLIC_KEY:
                return "wants to know who you are";
            case NIP04_ENCRYPT:
            case NIP44_ENCRYPT:
                return "wants to encrypt a message";
            case NIP04_DECRYPT:
            case NIP44_DECRYPT:
                return "wants to decrypt a message";
            case DECRYPT_ZAP_EVENT:
                return "wants to read a private zap";
            default:
                return "wants to use your key";
        }
    }

    // ── Choosing the account ─────────────────────────────────────────────────

    /**
     * Which account this request will be answered as, or null if none can be.
     *
     * <p>An event that names its own author outranks {@code current_user},
     * because it is the more specific statement and because signing it as
     * anybody else produces an event whose id the client did not ask for. Both
     * are only honoured for somebody actually signed in here; a client naming
     * an account Tenna does not have is answered as whoever it can, or not at
     * all.
     */
    @Nullable
    static String accountFor(
        @NonNull Context context,
        @Nullable String currentUser,
        @NonNull Request request
    ) {
        String author = request.eventAuthor();
        if (author != null && TennaAccounts.find(context, author) != null) return author;

        return TennaAccounts.resolve(context, currentUser);
    }

    // ── The policy ───────────────────────────────────────────────────────────

    /**
     * What this caller has been told before about this question.
     *
     * @return one of {@link SignerApps#ALLOW}, {@link SignerApps#DENY},
     *         {@link SignerApps#ASK}.
     */
    @NonNull
    static String decide(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @Nullable String requesterId,
        @NonNull Request request
    ) {
        String permission = request.method.permission;
        if (permission == null) return SignerApps.ASK;

        // A caller with no package is a web page reached through a browser,
        // and every one of them looks identical from here. Honouring a
        // remembered grant for that shared identity would let a decision made
        // about one website approve the next one silently, so they are always
        // asked. See the same reasoning in Amber, which learned it first.
        if (requesterId == null || requesterId.isEmpty()) return SignerApps.ASK;

        return SignerApps.decide(context, accountPubkey, requesterId, permission, request.eventKind());
    }

    /**
     * Answer if the answer is already known, and say so if it is not.
     *
     * <p>The whole background path is this method returning
     * {@link Outcome.Status#RESULT} without anything being drawn.
     */
    @NonNull
    static Outcome answer(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @Nullable String requesterId,
        @NonNull Request request
    ) {
        switch (decide(context, accountPubkey, requesterId, request)) {
            case SignerApps.DENY:
                return Outcome.rejected();
            case SignerApps.ALLOW:
                return run(context, accountPubkey, request);
            default:
                return Outcome.needsApproval();
        }
    }

    // ── The work ─────────────────────────────────────────────────────────────

    /**
     * Do it, having been told to.
     *
     * <p>No permission is consulted. Callers reach this either through
     * {@link #answer}, which has already checked, or straight from the user
     * pressing Allow, which is the check.
     */
    @NonNull
    static Outcome run(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull Request request
    ) {
        // Checked here rather than left to the cipher, which answers a missing
        // peer the same way it answers a bad MAC — with nothing — and this is
        // a malformed request rather than a failed one.
        if (request.method.needsPeer() && (request.peer == null || request.peer.length() != 64)) {
            return Outcome.error("A valid pubkey is required for that request");
        }

        // Two questions that are about the account rather than about its key,
        // and are answered the same whatever is holding it: who this is, and
        // whether anyone is listening. Answering them here is what lets a
        // client log in to an account whose key lives in another app, with
        // nothing on screen and nobody else asked.
        switch (request.method) {
            case GET_PUBLIC_KEY:
                return Outcome.result(accountPubkey);
            case PING:
                return Outcome.result("pong");
            default:
                break;
        }

        // Everything past here needs the key, so it goes to whatever is
        // holding it.
        TennaAccounts.Account account = TennaAccounts.find(context, accountPubkey);
        String type = account == null ? "" : account.type;

        if (TennaAccounts.TYPE_ANDROID_SIGNER.equals(type)) {
            return AndroidSigner.query(context, account.packageName, accountPubkey, request);
        }

        if (!TennaKeys.has(context, accountPubkey)) {
            // Signed in, but through something this version cannot ask. A
            // remote signer is the case that gets here today.
            return Outcome.error("Tenna cannot reach the signer for that account");
        }

        return local(context, accountPubkey, request);
    }

    /** Sign with a key sealed in this app's own process. */
    @NonNull
    private static Outcome local(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull Request request
    ) {
        if (!NostrCrypto.isAvailable()) return Outcome.error("This device has no native signer");

        byte[] sk = TennaKeys.get(context, accountPubkey);
        if (sk == null) return Outcome.error("No key on this device for that account");

        try {
            switch (request.method) {
                case SIGN_EVENT:
                    return signEvent(sk, request.payload);

                case NIP44_ENCRYPT:
                    return cipher(NostrCipher.encrypt44(
                        NostrCrypto.conversationKey(sk, request.peer), request.payload));

                case NIP44_DECRYPT:
                    return cipher(NostrCipher.decrypt44(
                        NostrCrypto.conversationKey(sk, request.peer), request.payload));

                case NIP04_ENCRYPT:
                    return cipher(NostrCipher.encrypt04(
                        NostrCrypto.sharedSecret(sk, request.peer), request.payload));

                case NIP04_DECRYPT:
                    return cipher(NostrCipher.decrypt04(
                        NostrCrypto.sharedSecret(sk, request.peer), request.payload));

                case DECRYPT_ZAP_EVENT:
                    return decryptZap(sk, request.payload);

                default:
                    return Outcome.error("Unrecognized method: " + request.method.wire);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not answer a " + request.method.wire + " request", e);
            return Outcome.error("Could not answer the request");
        }
    }

    private static Outcome signEvent(byte[] sk, String payload) throws Exception {
        JSONObject template = new JSONObject(payload);

        int kind = template.getInt("kind");
        String content = template.optString("content", "");
        JSONArray tags = template.optJSONArray("tags");
        if (tags == null) tags = new JSONArray();
        long createdAt = template.optLong("created_at", System.currentTimeMillis() / 1000);

        // Whatever id, pubkey or sig the caller put in is ignored, because
        // those are what this computes. A caller that disagrees about the id
        // would otherwise get a signature over its own idea of the event.
        JSONObject signed = NostrCrypto.finalizeEvent(kind, content, tags, createdAt, sk);
        return Outcome.signed(signed.getString("sig"), signed.toString());
    }

    /**
     * Read a private zap request.
     *
     * <p>The ciphertext is in the {@code anon} tag, encrypted to the recipient
     * from the throwaway key the event is signed with — so the other party is
     * the event's own author. Older senders put it in the content instead.
     */
    private static Outcome decryptZap(byte[] sk, String payload) throws Exception {
        JSONObject event = new JSONObject(payload);

        String peer = event.optString("pubkey", "");
        if (peer.length() != 64) return Outcome.error("That is not a zap request");

        String ciphertext = null;
        JSONArray tags = event.optJSONArray("tags");
        if (tags != null) {
            for (int i = 0; i < tags.length(); i++) {
                JSONArray tag = tags.optJSONArray(i);
                if (tag != null && tag.length() >= 2 && "anon".equals(tag.optString(0))) {
                    ciphertext = tag.optString(1);
                    break;
                }
            }
        }
        if (ciphertext == null || ciphertext.isEmpty()) ciphertext = event.optString("content", "");
        if (ciphertext.isEmpty()) return Outcome.error("That zap request is not private");

        return cipher(NostrCipher.decrypt04(NostrCrypto.sharedSecret(sk, peer), ciphertext));
    }

    /**
     * Wrap a cipher answer, keeping every failure the same failure.
     *
     * <p>{@link NostrCipher} returns null for a bad MAC, bad padding and a bad
     * key alike, and this keeps it that way. A caller that could tell them
     * apart has an oracle, and the caller here is another application.
     */
    private static Outcome cipher(@Nullable String result) {
        return result == null ? Outcome.error("Could not complete the request") : Outcome.result(result);
    }
}
