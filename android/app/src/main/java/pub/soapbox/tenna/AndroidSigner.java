package pub.soapbox.tenna;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

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
 * <p>Nothing here is Amber-specific. The package comes from the login, and
 * everything else is what the NIP says.
 */
final class AndroidSigner {

    private static final String TAG = "AndroidSigner";

    private AndroidSigner() {}

    // ── The background half ──────────────────────────────────────────────────

    /**
     * Ask the other signer's content resolver.
     *
     * <p>Reads its answer exactly as NIP-55 defines ours: a row with a result,
     * a row with {@code rejected}, or a null cursor meaning it cannot say
     * without asking somebody.
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
                return signed(eventJson, value);
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

    /**
     * A signed event from another signer, checked before it is passed on.
     *
     * <p>Verified rather than trusted, unlike a signature this app made
     * itself: another process answered, and nothing but the signature says it
     * is the app we asked. The client we hand it to will verify it too, and
     * would rather be told now.
     */
    @NonNull
    private static TennaSigning.Outcome signed(@NonNull String eventJson, @Nullable String value) {
        try {
            org.json.JSONObject event = new org.json.JSONObject(eventJson);
            String id = event.optString("id", "");
            String pubkey = event.optString("pubkey", "");
            String sig = event.optString("sig", "");

            org.json.JSONArray tags = event.optJSONArray("tags");
            if (tags == null) tags = new org.json.JSONArray();

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
        @NonNull TennaSigning.Request request,
        @Nullable Intent data
    ) {
        if (data == null) return TennaSigning.Outcome.rejected();

        // A refusal is RESULT_OK with a flag, which is why the caller must not
        // read a missing result as a crash.
        if (data.getBooleanExtra("rejected", false)) {
            return TennaSigning.Outcome.rejected();
        }

        String eventJson = data.getStringExtra("event");
        String value = data.getStringExtra("result");
        if (value == null) value = data.getStringExtra("signature");

        if (request.method == SignerTypes.Method.SIGN_EVENT) {
            if (eventJson == null || eventJson.isEmpty()) {
                return TennaSigning.Outcome.error("The signer app returned no event");
            }
            return signed(eventJson, value);
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
