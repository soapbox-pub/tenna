package pub.soapbox.tenna;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

/**
 * The accounts each site holds.
 *
 * <p>A site's {@code window.nostr} acts as whoever is signed in to Tenna, as
 * NIP-07 always has. A client that keeps several accounts of its own, as Din
 * lets websites do, asks for more with {@code requestPublicKey()} and signs as
 * any of them with {@code getSigner(pubkey)}, which keeps acting as that
 * account whatever Tenna switches to. What makes that safe is this record: a
 * site can only be pinned to an account it was given.
 *
 * <p>A site holds an account once it has been told it: by being opened while
 * that account was Tenna's (its provider is handed the pubkey on the way in,
 * so the site knows it from the first line), or by the user picking it for
 * {@code requestPublicKey()}. Signing out of Tenna takes the account away from
 * every site without touching this, because {@link #holds} asks whether it is
 * still signed in; revoking the site in Settings, or removing it from the
 * wall, takes it away here.
 *
 * <p>Native, rather than the web layer's storage, for the reason the grants
 * themselves are: the site's service worker asks with no WebView anywhere.
 * See {@link NsiteWorkerSigner}. Off Android the same record is kept in
 * {@code localStorage}; see {@code nsiteAccounts.ts}.
 */
final class NsiteAccounts {

    private static final String PREFS = "nsite-accounts";

    /** More than anyone has, and few enough that a site cannot fill the store. */
    private static final int MAX_PER_SITE = 32;

    private NsiteAccounts() {}

    private static SharedPreferences prefs(@NonNull Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Every account recorded for a site, oldest first, signed in or not. */
    @NonNull
    static synchronized List<String> held(@NonNull Context context, @NonNull String siteId) {
        List<String> out = new ArrayList<>();
        String raw = prefs(context).getString(siteId, null);
        if (raw == null) return out;
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                String pubkey = array.optString(i, "");
                if (isPubkey(pubkey) && !out.contains(pubkey)) out.add(pubkey);
            }
        } catch (JSONException e) {
            // Unreadable: the site holds nothing, and is asked again.
        }
        return out;
    }

    /** Give a site an account. */
    static synchronized void hold(@NonNull Context context, @NonNull String siteId, @NonNull String pubkey) {
        if (!isPubkey(pubkey)) return;
        List<String> accounts = held(context, siteId);
        if (accounts.contains(pubkey)) return;
        accounts.add(pubkey);
        while (accounts.size() > MAX_PER_SITE) accounts.remove(0);
        write(context, siteId, accounts);
    }

    /** Take one account back from a site. */
    static synchronized void release(@NonNull Context context, @NonNull String siteId, @NonNull String pubkey) {
        List<String> accounts = held(context, siteId);
        if (!accounts.remove(pubkey)) return;
        write(context, siteId, accounts);
    }

    /** Forget everything a site held, for a site that is gone. */
    static synchronized void forget(@NonNull Context context, @NonNull String siteId) {
        prefs(context).edit().remove(siteId).apply();
    }

    /**
     * Whether a site may act as this account now: it was given it, and
     * somebody is still signed in to Tenna as it.
     */
    static boolean holds(@NonNull Context context, @NonNull String siteId, @Nullable String pubkey) {
        if (pubkey == null || !isPubkey(pubkey)) return false;
        if (TennaAccounts.find(context, pubkey) == null) return false;
        return held(context, siteId).contains(pubkey);
    }

    private static void write(@NonNull Context context, @NonNull String siteId, @NonNull List<String> accounts) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (accounts.isEmpty()) editor.remove(siteId);
        else editor.putString(siteId, new JSONArray(accounts).toString());
        editor.apply();
    }

    static boolean isPubkey(@Nullable String value) {
        return value != null && value.matches("[0-9a-f]{64}");
    }
}
