package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Who is signed in, written down where code without a WebView can read it.
 *
 * The login list lives in the web layer, sealed inside a storage plugin's own
 * preferences under its own encryption. That is the right place for it — it is
 * the web layer's state — but it is no use at all to the three paths that have
 * to answer another application while no WebView exists: the content resolver,
 * the relay listener, and the part of the approval activity that decides
 * whether there is anything to approve before it boots anything.
 *
 * So the list is mirrored here. Same doctrine as {@code NsiteWall}: this is a
 * mirror and never an original. The web layer replaces the whole thing every
 * time the login list changes, so a crash between two writes, or cleared
 * storage, or a version that did not know about this, is corrected on the next
 * launch rather than accumulating.
 *
 * <p><b>Being in this list is not the same as being signable.</b> It says who
 * is logged in, which includes people whose key Tenna does not hold — somebody
 * signed in through a browser extension, a remote signer, or another signer app
 * on the phone. {@link TennaKeys} is what says whether there is a key here to
 * answer with, and every question about signing goes through it. The two are
 * kept apart because they are different facts, and the interesting case — a
 * user with one of each — is one where they disagree.
 */
final class TennaAccounts {

    private static final String PREFS = "tenna-accounts";
    private static final String KEY_ACCOUNTS = "accounts";

    private TennaAccounts() {}

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** One signed-in identity, as much of it as is worth drawing. */
    static final class Account {
        @NonNull final String pubkey;
        @NonNull final String name;
        @NonNull final String picture;

        Account(@NonNull String pubkey, @NonNull String name, @NonNull String picture) {
            this.pubkey = pubkey;
            this.name = name;
            this.picture = picture;
        }
    }

    /**
     * Replace the whole list.
     *
     * <p>Wholesale rather than one account at a time because the web layer
     * knows the whole answer and nothing here does. The argument is the JSON
     * the web layer serialised; it is stored as text and parsed on read, so a
     * shape this version does not understand costs a read rather than a write.
     */
    static synchronized void replace(@NonNull Context context, @Nullable String accountsJson) {
        prefs(context).edit().putString(KEY_ACCOUNTS, accountsJson == null ? "[]" : accountsJson).apply();
    }

    /** Everybody signed in, in the order the web layer keeps them. */
    @NonNull
    static synchronized List<Account> all(@NonNull Context context) {
        String raw = prefs(context).getString(KEY_ACCOUNTS, null);
        if (raw == null) return Collections.emptyList();

        List<Account> accounts = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject json = array.optJSONObject(i);
                if (json == null) continue;
                String pubkey = json.optString("pubkey", "");
                if (pubkey.length() != 64) continue;
                accounts.add(new Account(
                    pubkey,
                    json.optString("name", ""),
                    json.optString("picture", "")
                ));
            }
        } catch (JSONException e) {
            return Collections.emptyList();
        }
        return accounts;
    }

    /** The account the app is currently signed in as, or null. */
    @Nullable
    static synchronized Account active(@NonNull Context context) {
        List<Account> accounts = all(context);
        return accounts.isEmpty() ? null : accounts.get(0);
    }

    /** What is known about one pubkey, or null if nobody is signed in as it. */
    @Nullable
    static synchronized Account find(@NonNull Context context, @Nullable String pubkey) {
        if (pubkey == null) return null;
        for (Account account : all(context)) {
            if (account.pubkey.equals(pubkey)) return account;
        }
        return null;
    }

    /** A display name for a pubkey, falling back to a short form of the key. */
    @NonNull
    static String nameOf(@NonNull Context context, @NonNull String pubkey) {
        Account account = find(context, pubkey);
        if (account != null && !account.name.isEmpty()) return account.name;
        return shorten(pubkey);
    }

    /**
     * Which account should answer this request.
     *
     * <p>A client may name one with {@code current_user}, and usually should:
     * it is saying which of several identities it believes it is talking to,
     * and answering as somebody else would sign the wrong person's name. So a
     * named account wins whenever there is a key for it.
     *
     * <p>When the client names nobody, or names somebody this device cannot
     * sign for, the account in front of the user is the next best answer, and
     * the first one that can sign after that. Null means there is nothing to
     * answer with at all — either nobody is signed in, or everybody who is
     * keeps their key somewhere else.
     */
    @Nullable
    static synchronized String resolve(@NonNull Context context, @Nullable String requested) {
        if (requested != null && requested.length() == 64 && TennaKeys.has(context, requested)) {
            return requested;
        }

        for (Account account : all(context)) {
            if (TennaKeys.has(context, account.pubkey)) return account.pubkey;
        }

        return null;
    }

    /** Whether this device can sign for anybody at all. */
    static synchronized boolean anySignable(@NonNull Context context) {
        return resolve(context, null) != null;
    }

    /** {@code abcdef01…89abcdef}, for when there is no name to show. */
    @NonNull
    static String shorten(@NonNull String pubkey) {
        if (pubkey.length() < 16) return pubkey;
        return pubkey.substring(0, 8) + "\u2026" + pubkey.substring(pubkey.length() - 8);
    }
}
