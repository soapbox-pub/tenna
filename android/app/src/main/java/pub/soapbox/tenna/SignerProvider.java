package pub.soapbox.tenna;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Answering an application without opening anything.
 *
 * The other half of NIP-55. Once the user has said an app may do something,
 * asking again every time is not carefulness — it is a sheet that appears so
 * often nobody reads it, and clients that cannot do anything in the background
 * at all. So a client with a standing grant queries here instead, on a binder
 * thread, and gets the answer straight back.
 *
 * <p>Nothing about this path is a shortcut through the policy. It reaches
 * {@link TennaSigning} exactly as the activity does, with the same account
 * resolution and the same permission lookup; the only difference is that when
 * the answer is "nobody has decided", there is no way to ask, so it says so
 * and the client falls back to the intent.
 *
 * <p><b>The three outcomes are distinguished by the shape of the cursor, not
 * by a value in it.</b> That is what NIP-55 specifies and what every client
 * library already expects:
 *
 * <table>
 *   <tr><td>a row with {@code result}</td><td>granted</td></tr>
 *   <tr><td>a row with {@code rejected}</td><td>refused — stop asking</td></tr>
 *   <tr><td>a null cursor</td><td>undecided — open the sheet</td></tr>
 * </table>
 *
 * <p>A client that cannot tell the middle case from the last one will reopen
 * the sheet for a request the user has explicitly and permanently refused,
 * every time it wants it, which is the loop this distinction exists to break.
 *
 * <p>Exported with no permission of its own, which is correct and deliberate:
 * there is no Android permission that means "may ask about a key", and one
 * declared here would be one every client had to request. What guards it is
 * that the caller is named by the binder and answered only for what that name
 * has been granted.
 */
public class SignerProvider extends ContentProvider {

    private static final String TAG = "SignerProvider";

    @Override
    public boolean onCreate() {
        return true;
    }

    /**
     * The arguments, positionally, in the {@code projection} array.
     *
     * <p>An odd place to put them, and not a choice open to revisiting: NIP-55
     * says the payload travels in the query's projection, and the clients are
     * already written.
     */
    private static final int ARG_PAYLOAD = 0;
    private static final int ARG_PEER = 1;
    private static final int ARG_CURRENT_USER = 2;

    @Nullable
    @Override
    public Cursor query(
        @NonNull Uri uri,
        @Nullable String[] projection,
        @Nullable String selection,
        @Nullable String[] selectionArgs,
        @Nullable String sortOrder
    ) {
        android.content.Context context = getContext();
        if (context == null) return null;

        // The caller is whoever the binder says it is, never whoever the
        // arguments claim. An app cannot ask as another app.
        String requesterId = getCallingPackage();
        if (requesterId == null) return null;

        SignerTypes.Method method = SignerTypes.fromAuthority(uri.getAuthority());
        if (method == null || !method.isNip55()) return null;

        String payload = arg(projection, ARG_PAYLOAD);
        String peer = arg(projection, ARG_PEER);
        String currentUser = arg(projection, ARG_CURRENT_USER);

        TennaSigning.Request request =
            new TennaSigning.Request(method, payload == null ? "" : payload, peer);

        String account = TennaSigning.accountFor(context, currentUser, request);
        if (account == null) {
            // No key here for anybody the client could mean. Undecided rather
            // than refused: the sheet can say why, and this cannot.
            return null;
        }

        // Deliberately not rate limited. Everything answered here was answered
        // by the user already, and a decision does not wear out with use: an
        // app doing a burst of legitimate work — a screenful of messages to
        // decrypt, say — would find its own grant refused, fall back to the
        // intent, and put a queue of questions in front of somebody who had
        // said yes to all of them once. The limit belongs where the questions
        // are, which is {@link SignerActivity}.
        TennaSigning.Outcome outcome =
            TennaSigning.answer(context, account, requesterId, request, true);

        switch (outcome.status) {
            case RESULT:
                SignerApps.touch(context, account, requesterId);
                return answered(method, outcome);

            case REJECTED:
                return refused();

            case ERROR:
                Log.i(TAG, "Could not answer a background request: " + outcome.error);
                return null;

            default:
                // Either nobody has decided, or the signer behind this account
                // has to be asked in a window and a binder thread has not got
                // one. Both are the same answer here, and it is the one NIP-55
                // already defines: a null cursor means open the intent, which
                // can do what this cannot.
                return null;
        }
    }

    /** A granted answer. */
    @NonNull
    private static Cursor answered(
        @NonNull SignerTypes.Method method,
        @NonNull TennaSigning.Outcome outcome
    ) {
        String value = outcome.value == null ? "" : outcome.value;

        if (method == SignerTypes.Method.SIGN_EVENT) {
            // `signature` alongside `result` for the same reason the intent
            // carries both: one is what the NIP says and the other is what the
            // clients were written against.
            MatrixCursor cursor = new MatrixCursor(new String[] { "signature", "event", "result" });
            cursor.addRow(new Object[] { value, outcome.eventJson, value });
            return cursor;
        }

        MatrixCursor cursor = new MatrixCursor(new String[] { "signature", "result" });
        cursor.addRow(new Object[] { value, value });
        return cursor;
    }

    /** A standing no. The column's presence is the whole message. */
    @NonNull
    private static Cursor refused() {
        MatrixCursor cursor = new MatrixCursor(new String[] { "rejected" });
        cursor.addRow(new Object[] { "true" });
        return cursor;
    }

    @Nullable
    private static String arg(@Nullable String[] projection, int index) {
        if (projection == null || index >= projection.length) return null;
        String value = projection[index];
        return value == null || value.isEmpty() ? null : value;
    }

    // ── Nothing else is a content provider ───────────────────────────────────

    @Nullable
    @Override
    public String getType(@NonNull Uri uri) {
        return null;
    }

    @Nullable
    @Override
    public Uri insert(@NonNull Uri uri, @Nullable ContentValues values) {
        return null;
    }

    @Override
    public int delete(@NonNull Uri uri, @Nullable String selection, @Nullable String[] args) {
        return 0;
    }

    @Override
    public int update(@NonNull Uri uri, @Nullable ContentValues values,
                      @Nullable String selection, @Nullable String[] args) {
        return 0;
    }
}
