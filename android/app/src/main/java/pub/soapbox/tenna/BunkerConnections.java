package pub.soapbox.tenna;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

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
 * Standing permission for something that is not on this phone.
 *
 * A NIP-46 connection is a key of its own. Not the user's key — a fresh one,
 * made when the connection is made, whose only job is to be the address the
 * client talks to and the signature on the answers. That has two consequences
 * worth being deliberate about: the client never learns the user's pubkey
 * except by asking for it, and revoking a connection is throwing a key away
 * rather than editing a list.
 *
 * <p>The connection key is sealed under the same Keystore key the user's own
 * is, because it is the same kind of secret with the same blast radius —
 * anyone holding it can talk to that client as Tenna, forever. Amber keeps its
 * equivalent in plaintext in a database; there is no reason to.
 *
 * <p>Records are named by the connection's own public key, because that is
 * what the hot path has: an event arrives off a relay with a {@code p} tag,
 * and the tag is this. Everything else about the connection is a lookup away.
 *
 * <p>What a connection may *do* is not kept here. That lives in
 * {@link SignerApps} under the client's pubkey, beside the grants given to
 * apps on the phone, because "may this sign a kind 1" is the same question
 * whoever is asking and should not have two answers in two places.
 */
final class BunkerConnections {

    private static final String TAG = "BunkerConnections";
    private static final String DIRECTORY = "signer/bunker";

    private BunkerConnections() {}

    /** One remote client with a standing invitation. */
    static final class Connection {
        /** This connection's own public key — what the client addresses. */
        @NonNull final String localPubkey;
        /** The sealed secret behind it. Never leaves this class unopened. */
        @NonNull final String sealedKey;
        /** The account it signs for. */
        @NonNull final String accountPubkey;
        /** The client's pubkey, or empty until it has connected. */
        @NonNull final String clientPubkey;
        /** The secret a {@code bunker://} client must quote to connect. */
        @NonNull final String secret;
        final boolean connected;
        @NonNull final List<String> relays;
        @NonNull final String name;
        @NonNull final String url;
        @NonNull final String image;
        final long createdAt;
        final long lastUsed;

        Connection(
            @NonNull String localPubkey, @NonNull String sealedKey, @NonNull String accountPubkey,
            @NonNull String clientPubkey, @NonNull String secret, boolean connected,
            @NonNull List<String> relays, @NonNull String name, @NonNull String url,
            @NonNull String image, long createdAt, long lastUsed
        ) {
            this.localPubkey = localPubkey;
            this.sealedKey = sealedKey;
            this.accountPubkey = accountPubkey;
            this.clientPubkey = clientPubkey;
            this.secret = secret;
            this.connected = connected;
            this.relays = relays;
            this.name = name;
            this.url = url;
            this.image = image;
            this.createdAt = createdAt;
            this.lastUsed = lastUsed;
        }

        /** What the client is called, falling back to something identifiable. */
        @NonNull
        String displayName() {
            if (!name.isEmpty()) return name;
            if (!url.isEmpty()) {
                try {
                    String host = Uri.parse(url).getHost();
                    if (host != null && !host.isEmpty()) return host;
                } catch (Exception e) {
                    // Not a URL.
                }
            }
            return clientPubkey.isEmpty()
                ? "A remote app"
                : TennaAccounts.shorten(clientPubkey);
        }

        /**
         * The secret key, unsealed.
         *
         * <p>Package-private and used only to sign and decrypt on the spot.
         * Nothing hands it any further.
         */
        @Nullable
        byte[] key() {
            String hex = TennaKeys.open(sealedKey);
            byte[] sk = hex == null ? null : NostrCipher.hexToBytes(hex);
            return sk != null && sk.length == 32 ? sk : null;
        }

        @NonNull
        Connection bound(@NonNull String client, @NonNull List<String> withRelays,
                         @NonNull String withName, @NonNull String withUrl, @NonNull String withImage) {
            return new Connection(localPubkey, sealedKey, accountPubkey, client, secret, true,
                withRelays.isEmpty() ? relays : withRelays,
                withName.isEmpty() ? name : withName,
                withUrl.isEmpty() ? url : withUrl,
                withImage.isEmpty() ? image : withImage,
                createdAt, System.currentTimeMillis());
        }

        @NonNull
        Connection used() {
            return new Connection(localPubkey, sealedKey, accountPubkey, clientPubkey, secret,
                connected, relays, name, url, image, createdAt, System.currentTimeMillis());
        }

        @NonNull
        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("localPubkey", localPubkey);
            json.put("sealedKey", sealedKey);
            json.put("accountPubkey", accountPubkey);
            json.put("clientPubkey", clientPubkey);
            json.put("secret", secret);
            json.put("connected", connected);
            json.put("relays", new JSONArray(relays));
            json.put("name", name);
            json.put("url", url);
            json.put("image", image);
            json.put("createdAt", createdAt);
            json.put("lastUsed", lastUsed);
            return json;
        }

        @Nullable
        static Connection fromJson(@NonNull JSONObject json) {
            String localPubkey = json.optString("localPubkey", "");
            String sealedKey = json.optString("sealedKey", "");
            String accountPubkey = json.optString("accountPubkey", "");
            if (localPubkey.length() != 64 || sealedKey.isEmpty() || accountPubkey.length() != 64) {
                return null;
            }

            List<String> relays = new ArrayList<>();
            JSONArray array = json.optJSONArray("relays");
            if (array != null) {
                for (int i = 0; i < array.length(); i++) {
                    String relay = array.optString(i, "");
                    if (!relay.isEmpty()) relays.add(relay);
                }
            }

            return new Connection(
                localPubkey, sealedKey, accountPubkey,
                json.optString("clientPubkey", ""),
                json.optString("secret", ""),
                json.optBoolean("connected", false),
                relays,
                json.optString("name", ""),
                json.optString("url", ""),
                json.optString("image", ""),
                json.optLong("createdAt", 0),
                json.optLong("lastUsed", 0)
            );
        }
    }

    // ── Making one ───────────────────────────────────────────────────────────

    /**
     * Mint a connection, with a key of its own.
     *
     * <p>{@code clientPubkey} is empty for a {@code bunker://} invitation,
     * where the client is not known until it turns up and quotes the secret,
     * and set for {@code nostrconnect://}, where the client named itself.
     */
    @Nullable
    static synchronized Connection create(
        @NonNull Context context,
        @NonNull String accountPubkey,
        @NonNull String clientPubkey,
        @NonNull String secret,
        @NonNull List<String> relays,
        @NonNull String name,
        @NonNull String url,
        @NonNull String image
    ) {
        if (!NostrCrypto.isAvailable()) return null;

        byte[] sk = NostrCrypto.generateSecretKey();
        if (sk == null) return null;

        String localPubkey;
        String sealed;
        try {
            localPubkey = NostrCrypto.pubkeyOf(sk);
            sealed = TennaKeys.seal(NostrCrypto.bytesToHex(sk));
        } catch (Exception e) {
            return null;
        } finally {
            java.util.Arrays.fill(sk, (byte) 0);
        }
        if (sealed == null) {
            Log.w(TAG, "Could not seal a connection key; refusing to keep it");
            return null;
        }

        long now = System.currentTimeMillis();
        Connection connection = new Connection(
            localPubkey, sealed, accountPubkey, clientPubkey, secret,
            !clientPubkey.isEmpty(), relays, name, url, image, now, now
        );
        save(context, connection);
        return connection;
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    /** The connection a {@code p} tag names, or null. */
    @Nullable
    static synchronized Connection byLocalPubkey(@NonNull Context context, @NonNull String localPubkey) {
        return read(fileFor(context, localPubkey));
    }

    /** Every connection, newest use first. */
    @NonNull
    static synchronized List<Connection> all(@NonNull Context context) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return Collections.emptyList();

        List<Connection> connections = new ArrayList<>();
        for (File file : files) {
            Connection connection = read(file);
            if (connection != null) connections.add(connection);
        }
        Collections.sort(connections, (a, b) -> Long.compare(b.lastUsed, a.lastUsed));
        return connections;
    }

    /** Those belonging to one account. */
    @NonNull
    static synchronized List<Connection> forAccount(@NonNull Context context, @NonNull String accountPubkey) {
        List<Connection> mine = new ArrayList<>();
        for (Connection connection : all(context)) {
            if (connection.accountPubkey.equals(accountPubkey)) mine.add(connection);
        }
        return mine;
    }

    /** Whether anything is waiting to be talked to. */
    static synchronized boolean any(@NonNull Context context) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        return files != null && files.length > 0;
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    static synchronized void save(@NonNull Context context, @NonNull Connection connection) {
        try {
            write(
                fileFor(context, connection.localPubkey),
                connection.toJson().toString().getBytes(StandardCharsets.UTF_8)
            );
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Could not write a connection", e);
        }
    }

    /**
     * Throw a connection away, and everything it was allowed to do.
     *
     * <p>The key goes with it, which is what makes this final: the client is
     * talking to an address that no longer answers, and nothing it kept can
     * bring it back.
     */
    static synchronized void forget(@NonNull Context context, @NonNull String localPubkey) {
        Connection connection = byLocalPubkey(context, localPubkey);
        //noinspection ResultOfMethodCallIgnored
        fileFor(context, localPubkey).delete();

        if (connection != null && !connection.clientPubkey.isEmpty()) {
            SignerApps.forget(context, connection.accountPubkey, connection.clientPubkey);
        }
    }

    // ── Files ────────────────────────────────────────────────────────────────

    private static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private static File fileFor(Context context, String localPubkey) {
        return new File(directory(context), NsiteSites.key(localPubkey) + ".json");
    }

    @Nullable
    private static Connection read(File file) {
        if (!file.isFile()) return null;
        try {
            return Connection.fromJson(new JSONObject(
                new String(readFully(file), StandardCharsets.UTF_8)));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /** Write through a temp file, so a failed write leaves the old record intact. */
    private static void write(File destination, byte[] bytes) throws IOException {
        File temp = File.createTempFile("conn", null, destination.getParentFile());
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
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }
}
