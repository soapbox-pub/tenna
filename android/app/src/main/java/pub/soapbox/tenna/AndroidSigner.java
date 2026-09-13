package pub.soapbox.tenna;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Asking a signer app on this phone, on behalf of somebody who asked us.
 *
 * The other side of {@link SignerProvider} and {@link SignerActivity}: the
 * same NIP-55, with Tenna as the client. It is here because an account signed
 * in through Amber is still an account Tenna can sign for — it just has to ask
 * — and refusing on the grounds that the key is somewhere else would be Tenna
 * declining to do the one thing it is for.
 *
 * <p>Two ways in, and the order matters:
 *
 * <ol>
 *   <li><b>The other signer's content resolver.</b> Answers on a binder
 *       thread, with nothing on screen, when that signer has been told to
 *       remember this. It needs no activity, so it is the only one of the two
 *       that works from {@link SignerProvider} and from a relay request
 *       arriving with the app closed — which is what keeps background signing
 *       working for an account whose key is not here.
 *   <li><b>Its intent.</b> Where there is an activity to launch from, and the
 *       resolver said it could not answer. The other signer asks its own user,
 *       which is a second prompt after ours — unavoidable, and the reason ours
 *       comes first: it is the only one of the two that knows who really
 *       asked. Amber sees the request as Tenna's.
 * </ol>
 *
 * <p><b>Nothing that comes back is taken on trust.</b> Whichever way it
 * arrived, a signed event is checked against the request it answers before it
 * is passed on — see {@link #mismatch}.
 *
 * <p>Nothing here is Amber-specific. The package comes from the login, and
 * everything else is what the NIP says.
 */
final class AndroidSigner {

    private static final String TAG = "AndroidSigner";

    private AndroidSigner() {}

    // ── The background half ──────────────────────────────────────────────────

    /**
     * How long to wait on another app before giving up on the quiet way.
     *
     * <p>The call underneath is a binder transaction into a process that may
     * be cold, and it cannot be interrupted once it is in flight. Left
     * unbounded it would hold whatever thread asked — including, through
     * {@link SignerProvider}, a thread belonging to the client that asked us,
     * which would make one wedged signer look like three wedged apps.
     *
     * <p>Giving up is cheap: it means the same as any other "I cannot answer
     * without asking somebody", and the request goes on to the prompt.
     */
    private static final long PATIENCE_MS = 5_000;

    /**
     * Threads for waiting on another app.
     *
     * <p>Cached rather than fixed, and never joined: a binder call that hangs
     * hangs its thread for good, and the one thing that must not happen is for
     * the next request to queue behind it.
     */
    private static final ExecutorService ASKING = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "android-signer");
        thread.setDaemon(true);
        return thread;
    });

    /**
     * Ask the other signer's content resolver.
     *
     * <p>Reads its answer exactly as NIP-55 defines ours: a row with a result,
     * a row with {@code rejected}, or a null cursor meaning it cannot say
     * without asking somebody.
     *
     * <p><b>Blocks, though never for long — see {@link #PATIENCE_MS}.</b> Not
     * to be called from a thread that has a window on it; {@code TennaSigning}
     * takes the decision about which those are.
     *
     * @return a result or a refusal, or {@link TennaSigning.Outcome#needsActivity}
     *         when only a prompt will settle it.
     */
    @NonNull
    static TennaSigning.Outcome query(
        @NonNull Context context,
        @NonNull String packageName,
        @NonNull String accountPubkey,
        @NonNull TennaSigning.Request request
    ) {
        if (!canAsk(context, packageName)) {
            return TennaSigning.Outcome.error("That signer app is not installed");
        }
        if (request.method.authority == null) {
            return TennaSigning.Outcome.needsActivity();
        }

        Context app = context.getApplicationContext();
        Future<TennaSigning.Outcome> asking =
            ASKING.submit(() -> ask(app, packageName, accountPubkey, request));

        try {
            return asking.get(PATIENCE_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            // Left running rather than cancelled, because cancelling it would
            // not stop the binder call anyway. Its answer is simply nobody's.
            Log.i(TAG, "Gave up waiting for " + packageName);
            return TennaSigning.Outcome.needsActivity();
        }
    }

    /**
     * The same question as {@link #query}, asked on a thread of its own.
     *
     * <p>For a caller that has a window: it wants the quiet answer if there is
     * one — the other signer may have been told to remember this, and then
     * nobody needs to see anything — but finding that out is a call into
     * another process and must not happen on the thread that draws.
     *
     * <p>{@code answer} is called on that other thread, once, whatever
     * happens.
     */
    static void queryInBackground(
        @NonNull Context context,
        @NonNull String packageName,
        @NonNull String accountPubkey,
        @NonNull TennaSigning.Request request,
        @NonNull Answer answer
    ) {
        Context app = context.getApplicationContext();
        ASKING.execute(() -> answer.got(query(app, packageName, accountPubkey, request)));
    }

    /** What {@link #queryInBackground} comes back with. */
    interface Answer {
        void got(@NonNull TennaSigning.Outcome outcome);
    }

    /** The query itself, on a thread that is allowed to sit still. */
    @NonNull
    private static TennaSigning.Outcome ask(
        @NonNull Context context,
        @NonNull String packageName,
        @NonNull String accountPubkey,
        @NonNull TennaSigning.Request request
    ) {
        Uri uri = Uri.parse("content://" + packageName + "." + request.method.authority);

        // The payload travels in the projection, which is an odd place for it
        // and not a choice open to revisiting — it is what the NIP says and
        // what every signer already implements.
        String[] arguments = new String[] {
            request.payload,
            request.peer == null ? "" : request.peer,
            accountPubkey,
        };

        try (Cursor cursor = resolver(context).query(uri, arguments, null, null, null)) {
            if (cursor == null) return TennaSigning.Outcome.needsActivity();
            if (!cursor.moveToFirst()) return TennaSigning.Outcome.needsActivity();

            if (cursor.getColumnIndex("rejected") > -1) {
                return TennaSigning.Outcome.rejected();
            }

            // `event` first for a signed event, because that is the whole of
            // it; `result` otherwise. Probed by index rather than assumed, so
            // a signer that ships one and not the other still answers.
            String eventJson = column(cursor, "event");
            String value = column(cursor, "result");
            if (value == null) value = column(cursor, "signature");

            if (request.method == SignerTypes.Method.SIGN_EVENT) {
                if (eventJson == null) return TennaSigning.Outcome.needsActivity();
                return signed(accountPubkey, request.payload, eventJson, value);
            }

            return value == null
                ? TennaSigning.Outcome.needsActivity()
                : TennaSigning.Outcome.result(value);
        } catch (Exception e) {
            // A signer that is there but will not talk to us is one we cannot
            // answer for in the background. The prompt still can.
            Log.i(TAG, "Could not reach " + packageName + " in the background");
            return TennaSigning.Outcome.needsActivity();
        }
    }

    // ── Checking the answer ──────────────────────────────────────────────────

    /**
     * A signed event from another signer, checked before it is passed on.
     *
     * <p>Verified rather than trusted, unlike a signature this app made
     * itself: another process answered, and nothing but the bytes says what it
     * answered with. Two separate questions, and both have to be yes — is this
     * event really signed, and is it the event that was asked for.
     */
    @NonNull
    static TennaSigning.Outcome signed(
        @NonNull String accountPubkey,
        @NonNull String asked,
        @NonNull String eventJson,
        @Nullable String value
    ) {
        String wrong = mismatch(accountPubkey, asked, eventJson);
        if (wrong != null) {
            Log.w(TAG, "A signer app answered with " + wrong);
            return TennaSigning.Outcome.error("The signer app answered with " + wrong);
        }

        try {
            JSONObject event = new JSONObject(eventJson);
            String id = event.optString("id", "");
            String pubkey = event.optString("pubkey", "");
            String sig = event.optString("sig", "");

            JSONArray tags = event.optJSONArray("tags");
            if (tags == null) tags = new JSONArray();

            String computed = NostrCrypto.eventId(
                pubkey, event.optLong("created_at", 0), event.optInt("kind", -1),
                tags, event.optString("content", ""));

            boolean sound = computed.equals(id) && NostrCrypto.schnorrVerify(
                NostrCipher.hexToBytes(id),
                NostrCipher.hexToBytes(pubkey),
                NostrCipher.hexToBytes(sig));

            if (!sound) {
                Log.w(TAG, "A signer app answered with an event that is not signed");
                return TennaSigning.Outcome.error("The signer app returned an invalid signature");
            }

            return TennaSigning.Outcome.signed(
                value == null || value.isEmpty() ? sig : value, eventJson);
        } catch (Exception e) {
            return TennaSigning.Outcome.error("The signer app returned an event that cannot be read");
        }
    }

    /**
     * Whether the event that came back is the event that was asked for.
     *
     * <p>A signature only proves that somebody signed something. It does not
     * say <em>who</em> — a signer holding several keys can answer as the wrong
     * one, and a client that asked for an account and got a stranger's would
     * be logged in as somebody it never named. And it does not say <em>what</em>
     * — the sheet showed the user a kind, a body and a set of tags, and an
     * answer nobody compared against those is an answer that consent does not
     * bind. The relay AUTH case makes that concrete: its whole meaning is in a
     * challenge tag.
     *
     * <p>{@code created_at} is deliberately not compared. A request may leave
     * it out, in which case filling it in is the signer's job.
     *
     * @return null when it matches, or what is wrong with it, phrased to be
     *         read by whoever asked.
     */
    @Nullable
    static String mismatch(
        @NonNull String accountPubkey,
        @NonNull String asked,
        @NonNull String eventJson
    ) {
        JSONObject want;
        JSONObject have;
        try {
            want = new JSONObject(asked);
            have = new JSONObject(eventJson);
        } catch (Exception e) {
            return "an event that cannot be read";
        }

        if (!accountPubkey.equalsIgnoreCase(have.optString("pubkey", ""))) {
            return "a different account";
        }
        if (want.has("kind") && want.optInt("kind", -1) != have.optInt("kind", -2)) {
            return "a different kind of event";
        }
        if (!want.optString("content", "").equals(have.optString("content", ""))) {
            return "different content";
        }
        if (!tags(want).equals(tags(have))) {
            return "different tags";
        }

        return null;
    }

    /** An event's tags as plain lists, for comparing one set to another. */
    @NonNull
    private static List<List<String>> tags(@NonNull JSONObject event) {
        List<List<String>> tags = new ArrayList<>();

        JSONArray outer = event.optJSONArray("tags");
        if (outer == null) return tags;

        for (int i = 0; i < outer.length(); i++) {
            JSONArray tag = outer.optJSONArray(i);
            if (tag == null) continue;

            List<String> values = new ArrayList<>(tag.length());
            for (int j = 0; j < tag.length(); j++) {
                values.add(tag.optString(j, ""));
            }
            tags.add(values);
        }

        return tags;
    }

    @Nullable
    private static String column(@NonNull Cursor cursor, @NonNull String name) {
        int index = cursor.getColumnIndex(name);
        if (index < 0) return null;
        String value = cursor.getString(index);
        return value == null || value.isEmpty() ? null : value;
    }

    private static ContentResolver resolver(Context context) {
        return context.getApplicationContext().getContentResolver();
    }

    // ── The prompting half ───────────────────────────────────────────────────

    /**
     * The intent that puts the question to the other signer's own user.
     *
     * <p>Built the way the NIP describes for a native caller: the payload is
     * the URI, everything else is an extra. {@code current_user} is named so
     * that a signer holding several accounts answers as the right one.
     */
    @NonNull
    static Intent intentFor(
        @NonNull String packageName,
        @NonNull String accountPubkey,
        @NonNull TennaSigning.Request request
    ) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:" + request.payload));
        intent.setPackage(packageName);
        intent.putExtra("type", request.method.wire);
        intent.putExtra("current_user", accountPubkey);
        if (request.peer != null) {
            intent.putExtra("pubKey", request.peer);
            // Both spellings, because signers disagree about which one they
            // read and sending both costs a string.
            intent.putExtra("pubkey", request.peer);
        }
        return intent;
    }

    /** What came back from that intent. */
    @NonNull
    static TennaSigning.Outcome read(
        @NonNull String accountPubkey,
        @NonNull TennaSigning.Request request,
        @Nullable Intent data
    ) {
        if (data == null) return TennaSigning.Outcome.rejected();

        // A refusal is RESULT_OK with a flag, which is why the caller must not
        // read a missing result as a crash. Read as either a boolean or the
        // word: signers disagree, and a refusal misread as a failure is a
        // standing "no" that gets asked again tomorrow.
        if (data.getBooleanExtra("rejected", false)
            || "true".equals(data.getStringExtra("rejected"))) {
            return TennaSigning.Outcome.rejected();
        }

        String eventJson = data.getStringExtra("event");
        String value = data.getStringExtra("result");
        if (value == null) value = data.getStringExtra("signature");

        if (request.method == SignerTypes.Method.SIGN_EVENT) {
            if (eventJson == null || eventJson.isEmpty()) {
                return TennaSigning.Outcome.error("The signer app returned no event");
            }
            return signed(accountPubkey, request.payload, eventJson, value);
        }

        return value == null
            ? TennaSigning.Outcome.error("The signer app returned nothing")
            : TennaSigning.Outcome.result(value);
    }

    // ── Who we may ask ───────────────────────────────────────────────────────

    /**
     * Whether this package is a signer we can and should ask.
     *
     * <p>Never ourselves. Tenna answers {@code nostrsigner:} now, so an
     * account whose login names Tenna's own package — a stale one, or a
     * confused one — would have this app forwarding its own requests to
     * itself, forever.
     */
    static boolean canAsk(@NonNull Context context, @Nullable String packageName) {
        if (packageName == null || packageName.isEmpty()) return false;
        if (packageName.equals(context.getPackageName())) {
            Log.w(TAG, "An account names Tenna as its own signer; refusing to ask ourselves");
            return false;
        }

        try {
            context.getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
