package pub.soapbox.tenna;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Who has been given a key, and what they were given it for.
 *
 * One record per application that has ever been answered, written as a file of
 * its own so that revoking is a delete rather than a rewrite of everybody
 * else's grants. An application here is anything that can ask: an app on the
 * phone, named by the package name the binder reports, or a remote client,
 * named by the pubkey it talks to us with. Both are strings nobody but the
 * platform can put words in, which is the property that matters — a name a
 * caller could choose for itself would be a name a caller could borrow.
 *
 * <p><b>Records are scoped to an account.</b> The file name mixes the account
 * pubkey in with the requester id, so a grant given while signed in as one
 * person says nothing about what the same app may do as another. Somebody with
 * a public account and a private one has two identities on this device, and an
 * app that was let near the first has not been let near the second.
 *
 * <p>Unlike {@code nsitePermissions.ts}, which holds the same shape for sites
 * in the web layer's storage, this store is the original rather than a mirror.
 * It has to be: the content resolver and the relay path both answer with no
 * WebView anywhere, so the only copy that can be consulted at the moment of
 * the question is this one. The settings screen reads it back over the bridge.
 *
 * <p>Grants carry no expiry. Tenna's answer to a site is {@code allow},
 * {@code deny} or {@code ask} and nothing else, and an app is not a harder
 * question than a site: a permission that lapses on a timer is one the user is
 * asked about again at a moment they have no context for, which teaches the
 * habit of approving to make the sheet go away.
 */
final class SignerApps {

    private static final String DIRECTORY = "signer/apps";
    private static final String ICONS = "signer/icons";

    /** An app on this phone, named by its package. */
    static final String KIND_PACKAGE = "package";
    /** A remote client over NIP-46, named by its pubkey. */
    static final String KIND_BUNKER = "bunker";
    /** A web page that reached us with no package behind it. */
    static final String KIND_WEB = "web";

    static final String ALLOW = "allow";
    static final String DENY = "deny";
    static final String ASK = "ask";

    private SignerApps() {}

    // ── The shape of a record ────────────────────────────────────────────────

    /** One remembered decision. */
    static final class Permission {
        @NonNull final String type;
        /** The event kind, for {@code signEvent}; null for everything else. */
        @Nullable final Integer kind;
        final boolean allowed;

        Permission(@NonNull String type, @Nullable Integer kind, boolean allowed) {
            this.type = type;
            this.kind = kind;
            this.allowed = allowed;
        }

        /** Whether this entry is the answer to a question about {@code type}/{@code kind}. */
        boolean matches(@NonNull String type, @Nullable Integer kind) {
            if (!this.type.equals(type)) return false;
            // Only signing is asked about per kind. Everything else is one
            // question — an app that may decrypt may decrypt.
            if (!SignerTypes.PERM_SIGN_EVENT.equals(type)) return true;
            return this.kind == null ? kind == null : this.kind.equals(kind);
        }

        @NonNull
        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("type", type);
            if (kind != null) json.put("kind", (int) kind);
            json.put("allowed", allowed);
            return json;
        }

        @Nullable
        static Permission fromJson(@Nullable JSONObject json) {
            if (json == null) return null;
            String type = json.optString("type", "");
            if (type.isEmpty()) return null;
            Integer kind = json.has("kind") && !json.isNull("kind")
                ? json.optInt("kind") : null;
            return new Permission(type, kind, json.optBoolean("allowed", false));
        }
    }

    /** Everything remembered about one application, under one account. */
    static final class Record {
        @NonNull final String accountPubkey;
        @NonNull final String requesterId;
        @NonNull final String kind;
        @NonNull final String name;
        /** The client's own url, when it told us one. NIP-46 only. */
        @NonNull final String url;
        /** The relays a remote client is reached on. Empty for a local app. */
        @NonNull final List<String> relays;
        final long createdAt;
        final long lastUsed;
        @NonNull final List<Permission> permissions;

        Record(
            @NonNull String accountPubkey,
            @NonNull String requesterId,
            @NonNull String kind,
            @NonNull String name,
            @NonNull String url,
            @NonNull List<String> relays,
            long createdAt,
            long lastUsed,
            @NonNull List<Permission> permissions
        ) {
            this.accountPubkey = accountPubkey;
            this.requesterId = requesterId;
            this.kind = kind;
            this.name = name;
            this.url = url;
            this.relays = relays;
            this.createdAt = createdAt;
            this.lastUsed = lastUsed;
            this.permissions = permissions;
        }

        /** This record with a different permission list. */
        @NonNull
        Record withPermissions(@NonNull List<Permission> next, long lastUsed) {
            return new Record(accountPubkey, requesterId, kind, name, url, relays,
                createdAt, lastUsed, next);
        }

        @NonNull
        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("accountPubkey", accountPubkey);
            json.put("requesterId", requesterId);
            json.put("kind", kind);
            json.put("name", name);
            json.put("url", url);
            json.put("relays", new JSONArray(relays));
            json.put("createdAt", createdAt);
            json.put("lastUsed", lastUsed);

            JSONArray perms = new JSONArray();
            for (Permission permission : permissions) perms.put(permission.toJson());
            json.put("permissions", perms);
            return json;
        }

        @Nullable
        static Record fromJson(@NonNull JSONObject json) {
            String accountPubkey = json.optString("accountPubkey", "");
            String requesterId = json.optString("requesterId", "");
            if (accountPubkey.length() != 64 || requesterId.isEmpty()) return null;

            List<String> relays = new ArrayList<>();
            JSONArray relayArray = json.optJSONArray("relays");
            if (relayArray != null) {
                for (int i = 0; i < relayArray.length(); i++) {
                    String relay = relayArray.optString(i, "");
                    if (!relay.isEmpty()) relays.add(relay);
                }
            }

            List<Permission> permissions = new ArrayList<>();
            JSONArray permArray = json.optJSONArray("permissions");
            if (permArray != null) {
                for (int i = 0; i < permArray.length(); i++) {
                    Permission permission = Permission.fromJson(permArray.optJSONObject(i));
                    if (permission != null) permissions.add(permission);
                }
            }

            return new Record(
                accountPubkey,
                requesterId,
                json.optString("kind", KIND_PACKAGE),
                json.optString("name", requesterId),
                json.optString("url", ""),
                relays,
                json.optLong("createdAt", 0),
                json.optLong("lastUsed", 0),
                permissions
            );
        }
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    /** What this app was told last time it asked this, or {@link #ASK}. */
    @NonNull
    static synchronized String decide(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId,
        @NonNull String type,
        @Nullable Integer kind
    ) {
        Record record = get(context, accountPubkey, requesterId);
        if (record == null) return ASK;

        for (Permission permission : record.permissions) {
            if (permission.matches(type, kind)) return permission.allowed ? ALLOW : DENY;
        }

        // A grant for signing in general answers a question about one kind.
        // Nothing writes one today — the drawer always records the kind it was
        // shown — but a connection approved with a bare `sign_event` in its
        // requested permissions would, and it means what it says.
        if (SignerTypes.PERM_SIGN_EVENT.equals(type) && kind != null) {
            for (Permission permission : record.permissions) {
                if (permission.type.equals(type) && permission.kind == null) {
                    return permission.allowed ? ALLOW : DENY;
                }
            }
        }

        return ASK;
    }

    /** The record for one application, or null if it has never been answered. */
    @Nullable
    static synchronized Record get(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId
    ) {
        return read(fileFor(context, accountPubkey, requesterId));
    }

    /** Every application this account has answered, newest use first. */
    @NonNull
    static synchronized List<Record> all(@NonNull Context context, @NonNull String accountPubkey) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return Collections.emptyList();

        List<Record> records = new ArrayList<>();
        for (File file : files) {
            Record record = read(file);
            if (record != null && record.accountPubkey.equals(accountPubkey)) records.add(record);
        }

        Collections.sort(records, (a, b) -> Long.compare(b.lastUsed, a.lastUsed));
        return records;
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /**
     * Remember an answer, creating the application's record if this is the
     * first one. Replaces any previous answer to the same question.
     */
    static synchronized void grant(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId,
        @NonNull String appKind,
        @NonNull String name,
        @NonNull String type,
        @Nullable Integer kind,
        boolean allowed
    ) {
        Record record = get(context, accountPubkey, requesterId);
        long now = System.currentTimeMillis();

        if (record == null) {
            record = new Record(accountPubkey, requesterId, appKind, name, "",
                Collections.emptyList(), now, now, Collections.emptyList());
        }

        List<Permission> next = new ArrayList<>();
        for (Permission permission : record.permissions) {
            if (!permission.matches(type, kind)) next.add(permission);
        }
        next.add(new Permission(type, kind, allowed));

        save(context, record.withPermissions(next, now));
    }

    /** Write a record whole. Used by the connection store, which owns more fields. */
    static synchronized void save(@NonNull Context context, @NonNull Record record) {
        try {
            write(
                fileFor(context, record.accountPubkey, record.requesterId),
                record.toJson().toString().getBytes(StandardCharsets.UTF_8)
            );
        } catch (IOException | JSONException e) {
            // A grant that could not be written is a grant the user will be
            // asked for again. Annoying, and better than a silent one.
            android.util.Log.w("SignerApps", "Could not write a grant", e);
        }
    }

    /** Drop one remembered answer, and the record with it if it was the last. */
    static synchronized void revoke(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId,
        @NonNull String type,
        @Nullable Integer kind
    ) {
        Record record = get(context, accountPubkey, requesterId);
        if (record == null) return;

        List<Permission> next = new ArrayList<>();
        for (Permission permission : record.permissions) {
            if (!permission.matches(type, kind)) next.add(permission);
        }

        if (next.isEmpty()) {
            forget(context, accountPubkey, requesterId);
            return;
        }
        save(context, record.withPermissions(next, record.lastUsed));
    }

    /** Forget an application entirely. */
    static synchronized void forget(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId
    ) {
        //noinspection ResultOfMethodCallIgnored
        fileFor(context, accountPubkey, requesterId).delete();
    }

    /** Note that an application asked something, whatever the answer was. */
    static synchronized void touch(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String requesterId
    ) {
        Record record = get(context, accountPubkey, requesterId);
        if (record == null) return;
        save(context, record.withPermissions(record.permissions, System.currentTimeMillis()));
    }

    // ── Icons ────────────────────────────────────────────────────────────────

    /**
     * Where an application's icon is kept.
     *
     * <p>Android shows an app the packages it is currently interacting with
     * and no others. That is enough to draw the sheet while the request is in
     * front of the user, and gone by the time the settings screen wants to
     * list who has been given a key — so the icon is copied here during the
     * request, while we are still allowed to see it.
     */
    @NonNull
    static File iconFile(@NonNull Context context, @NonNull String requesterId) {
        File dir = new File(context.getFilesDir(), ICONS);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, NsiteSites.key(requesterId) + ".png");
    }

    // ── Files ────────────────────────────────────────────────────────────────

    private static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /**
     * The file a record lives in.
     *
     * <p>Hashed because a requester id is a package name or a pubkey and a
     * record is scoped to an account, so the name has to carry both without
     * either reaching a path. The separator is a NUL so that no pair of
     * account and requester can be spelled two ways.
     */
    private static File fileFor(Context context, String accountPubkey, String requesterId) {
        return new File(directory(context), NsiteSites.key(accountPubkey + "\u0000" + requesterId) + ".json");
    }

    @Nullable
    private static Record read(File file) {
        if (!file.isFile()) return null;
        try {
            String json = new String(readFully(file), StandardCharsets.UTF_8);
            return Record.fromJson(new JSONObject(json));
        } catch (IOException | JSONException e) {
            // A truncated record is no record, and the user is asked again.
            return null;
        }
    }

    /** Write through a temp file, so a failed write leaves the old record intact. */
    private static void write(File destination, byte[] bytes) throws IOException {
        File temp = File.createTempFile("grant", null, destination.getParentFile());
        try (OutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw e;
        }

        //noinspection ResultOfMethodCallIgnored
        destination.delete();
        if (!temp.renameTo(destination)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw new IOException("Could not write " + destination.getName());
        }
    }

    private static byte[] readFully(File file) throws IOException {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }
}
