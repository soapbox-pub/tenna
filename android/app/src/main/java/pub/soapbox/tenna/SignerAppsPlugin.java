package pub.soapbox.tenna;

import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * What the settings screen needs to show who has been given a key.
 *
 * Read-mostly. Everything here is already decided somewhere else — a grant was
 * written when the user pressed Allow, a connection was made when they pasted
 * a link — and this exists so that the list of it can be drawn in React, where
 * the rest of Tenna's screens are.
 *
 * <p>The two writes are both revocations, which is the one thing a settings
 * screen has to be able to do that nothing else can: a grant is given in the
 * moment it is needed and taken back long afterwards, from somewhere the user
 * went looking.
 *
 * <p>Permission lists cross as JSON text rather than as objects, for the
 * reason everything else in this app does: Capacitor's coercion does not keep
 * an arbitrarily shaped array intact, and a permission whose kind went missing
 * on the way across is a row that revokes the wrong thing.
 */
@CapacitorPlugin(name = "SignerApps")
public class SignerAppsPlugin extends Plugin {

    // ── Applications ─────────────────────────────────────────────────────────

    /** Everything one account has given a key to, newest use first. */
    @PluginMethod
    public void list(PluginCall call) {
        String account = call.getString("account");
        if (account == null || account.length() != 64) {
            call.reject("account is required");
            return;
        }

        JSONArray apps = new JSONArray();
        for (SignerApps.Record record : SignerApps.all(getContext(), account)) {
            apps.put(describe(record));
        }

        JSObject result = new JSObject();
        result.put("apps", apps.toString());
        call.resolve(result);
    }

    /** One application's record, or null if it has never been answered. */
    @PluginMethod
    public void get(PluginCall call) {
        String account = call.getString("account");
        String requesterId = call.getString("requesterId");
        if (account == null || account.length() != 64 || requesterId == null) {
            call.reject("account and requesterId are required");
            return;
        }

        SignerApps.Record record = SignerApps.get(getContext(), account, requesterId);

        JSObject result = new JSObject();
        result.put("app", record == null ? null : describe(record).toString());
        call.resolve(result);
    }

    /**
     * What this application was told last time it asked this.
     *
     * <p>{@code allow}, {@code deny} or {@code ask}. The web layer asks before
     * it prompts, exactly as {@link TennaSigning#answer} does for every other
     * transport, so that a grant made from one of them is honoured by all.
     */
    @PluginMethod
    public void decide(PluginCall call) {
        String account = call.getString("account");
        String requesterId = call.getString("requesterId");
        String type = call.getString("type");
        if (account == null || requesterId == null || type == null) {
            call.reject("account, requesterId and type are required");
            return;
        }

        JSObject result = new JSObject();
        result.put("decision",
            SignerApps.decide(getContext(), account, requesterId, type, call.getInt("kind")));
        call.resolve(result);
    }

    /**
     * Write down an answer the user gave in the web layer.
     *
     * <p>The one write here that is not a revocation, and it exists because
     * the sheet over an nsite is drawn in React while the record it produces
     * has to be readable from a service worker fetch with no WebView in front
     * of it. See {@code nsitePermissions.ts}.
     */
    @PluginMethod
    public void grant(PluginCall call) {
        String account = call.getString("account");
        String requesterId = call.getString("requesterId");
        String type = call.getString("type");
        Boolean allowed = call.getBoolean("allowed");
        if (account == null || requesterId == null || type == null || allowed == null) {
            call.reject("account, requesterId, type and allowed are required");
            return;
        }

        SignerApps.grant(
            getContext(),
            account,
            requesterId,
            call.getString("appKind", SignerApps.KIND_NSITE),
            call.getString("name", requesterId),
            type,
            call.getInt("kind"),
            allowed
        );
        call.resolve();
    }

    /** Take back one thing an application was allowed to do. */
    @PluginMethod
    public void revoke(PluginCall call) {
        String account = call.getString("account");
        String requesterId = call.getString("requesterId");
        String type = call.getString("type");
        if (account == null || requesterId == null || type == null) {
            call.reject("account, requesterId and type are required");
            return;
        }

        SignerApps.revoke(getContext(), account, requesterId, type, call.getInt("kind"));
        call.resolve();
    }

    /**
     * Forget an application entirely.
     *
     * <p>If it was a remote connection, its key goes too — which is what makes
     * that final, since the address the client is talking to stops existing.
     */
    @PluginMethod
    public void forget(PluginCall call) {
        String account = call.getString("account");
        String requesterId = call.getString("requesterId");
        if (account == null || requesterId == null) {
            call.reject("account and requesterId are required");
            return;
        }

        for (BunkerConnections.Connection connection
                : BunkerConnections.forAccount(getContext(), account)) {
            if (connection.clientPubkey.equals(requesterId)) {
                BunkerConnections.forget(getContext(), connection.localPubkey);
            }
        }

        SignerApps.forget(getContext(), account, requesterId);
        NappPushService.sync(getContext());
        call.resolve();
    }

    // ── Connections ──────────────────────────────────────────────────────────

    /** Every remote connection this account has, with the link that made it. */
    @PluginMethod
    public void listConnections(PluginCall call) {
        String account = call.getString("account");
        if (account == null || account.length() != 64) {
            call.reject("account is required");
            return;
        }

        JSONArray connections = new JSONArray();
        for (BunkerConnections.Connection connection
                : BunkerConnections.forAccount(getContext(), account)) {
            connections.put(describe(connection));
        }

        JSObject result = new JSObject();
        result.put("connections", connections.toString());
        call.resolve(result);
    }

    /**
     * Make an invitation for a client that has not turned up yet.
     *
     * <p>The connection exists from this moment, listening, with nothing
     * allowed. Whoever quotes the secret first becomes its client, and is then
     * asked about everything it wants to do.
     */
    @PluginMethod
    public void createConnection(PluginCall call) {
        String account = call.getString("account");
        if (account == null || TennaAccounts.find(getContext(), account) == null) {
            call.reject("Nobody is signed in to that account");
            return;
        }

        List<String> relays = relays(call.getArray("relays"));
        if (relays.isEmpty()) {
            call.reject("At least one relay is required");
            return;
        }

        BunkerConnections.Connection connection = BunkerConnections.create(
            getContext(), account, "", java.util.UUID.randomUUID().toString(),
            relays, "", "", "");
        if (connection == null) {
            call.reject("Could not make a connection");
            return;
        }

        NappPushService.announceConnection(getContext(), connection.localPubkey);

        JSObject result = new JSObject();
        result.put("uri", BunkerUris.bunkerUri(connection));
        result.put("localPubkey", connection.localPubkey);
        call.resolve(result);
    }

    /**
     * Accept an invitation a client made.
     *
     * <p>The client named itself, its relays, and a secret Tenna has to quote
     * back, so the connection is bound on the spot rather than waiting for
     * anyone to turn up. The acceptance is published by the service, once the
     * subscription for it is live — see {@code NappPushService.announce}.
     */
    @PluginMethod
    public void connect(PluginCall call) {
        String account = call.getString("account");
        String uri = call.getString("uri");
        if (account == null || TennaAccounts.find(getContext(), account) == null) {
            call.reject("Nobody is signed in to that account");
            return;
        }
        if (uri == null) {
            call.reject("uri is required");
            return;
        }

        BunkerUris.NostrConnect parsed = BunkerUris.parseNostrConnect(uri);
        if (parsed == null) {
            call.reject("That is not a connection link");
            return;
        }

        BunkerConnections.Connection connection = BunkerConnections.create(
            getContext(), account, parsed.clientPubkey, parsed.secret,
            parsed.relays, parsed.name, parsed.url, parsed.image);
        if (connection == null) {
            call.reject("Could not make a connection");
            return;
        }

        // What the client asked for in its link, granted because accepting the
        // link is the approval. Anything it asks for beyond this is asked
        // about one at a time, like any other app.
        SignerApps.grant(getContext(), account, parsed.clientPubkey,
            SignerApps.KIND_BUNKER, connection.displayName(),
            SignerTypes.PERM_GET_PUBLIC_KEY, null, true);
        SignerApps.grant(getContext(), account, parsed.clientPubkey,
            SignerApps.KIND_BUNKER, connection.displayName(),
            SignerTypes.PERM_PING, null, true);

        for (String perm : parsed.perms.split(",")) {
            Integer[] kind = new Integer[1];
            String permission = SignerTypes.permissionFromPerm(perm, kind);
            if (permission == null) continue;
            SignerApps.grant(getContext(), account, parsed.clientPubkey,
                SignerApps.KIND_BUNKER, connection.displayName(), permission, kind[0], true);
        }

        NappPushService.announceConnection(getContext(), connection.localPubkey);

        JSObject result = new JSObject();
        result.put("name", connection.displayName());
        result.put("localPubkey", connection.localPubkey);
        call.resolve(result);
    }

    /** Throw a connection away, key and all. */
    @PluginMethod
    public void revokeConnection(PluginCall call) {
        String localPubkey = call.getString("localPubkey");
        if (localPubkey == null) {
            call.reject("localPubkey is required");
            return;
        }

        BunkerConnections.forget(getContext(), localPubkey);
        NappPushService.sync(getContext());
        call.resolve();
    }

    // ── Describing ───────────────────────────────────────────────────────────

    @NonNull
    private org.json.JSONObject describe(@NonNull SignerApps.Record record) {
        org.json.JSONObject json = new org.json.JSONObject();
        try {
            json.put("requesterId", record.requesterId);
            json.put("kind", record.kind);
            json.put("name", record.name);
            json.put("createdAt", record.createdAt);
            json.put("lastUsed", record.lastUsed);
            SignerApps.Icon art = SignerApps.iconOf(getContext(), record.requesterId);
            json.put("icon", art == null ? null : icon(art.file));
            json.put("adaptive", art != null && art.adaptive);

            JSONArray permissions = new JSONArray();
            for (SignerApps.Permission permission : record.permissions) {
                permissions.put(permission.toJson());
            }
            json.put("permissions", permissions);
        } catch (JSONException e) {
            // A row that cannot be described is one the screen leaves out,
            // which is better than a screen that does not draw.
        }
        return json;
    }

    @NonNull
    private org.json.JSONObject describe(@NonNull BunkerConnections.Connection connection) {
        org.json.JSONObject json = new org.json.JSONObject();
        try {
            json.put("localPubkey", connection.localPubkey);
            json.put("clientPubkey", connection.clientPubkey);
            json.put("name", connection.displayName());
            json.put("connected", connection.connected);
            json.put("uri", BunkerUris.bunkerUri(connection));
            json.put("relays", new JSONArray(connection.relays));
            json.put("createdAt", connection.createdAt);
            json.put("lastUsed", connection.lastUsed);
        } catch (JSONException e) {
            // As above.
        }
        return json;
    }

    /**
     * An application's icon as a data URL, or null.
     *
     * <p>Read off disk rather than from the package manager, because by the
     * time this screen is open the app is not interacting with us and Android
     * will not show it to us. It was copied there during a request — see
     * {@link SignerActivity}.
     */
    @Nullable
    private String icon(@NonNull File file) {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return "data:image/png;base64,"
                + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (IOException e) {
            return null;
        }
    }

    @NonNull
    private static List<String> relays(@Nullable JSArray given) {
        List<String> relays = new ArrayList<>();
        if (given == null) return relays;

        try {
            for (Object value : given.toList()) {
                if (!(value instanceof String)) continue;
                String relay = BunkerUris.normalizeRelay((String) value);
                if (relay != null && !relays.contains(relay)) relays.add(relay);
            }
        } catch (JSONException e) {
            return relays;
        }
        return relays;
    }
}
