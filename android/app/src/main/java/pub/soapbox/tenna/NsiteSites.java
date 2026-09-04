package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * What an nsite needs on disk to be launched in a window of its own.
 *
 * A site's window outlives the process that opened it — a shortcut on the
 * launcher is pressed cold, and a task the system killed is resumed from its
 * base intent alone. Either way the lineup hasn't been fetched, no relay has
 * been dialled, and the site's manifest is nowhere in memory. So the manifest
 * event is written here when the site is opened or pinned and read back when
 * the window starts, which is what lets a site go straight into its own
 * document. The web layer refreshes the record from the relay once it is
 * running, for next time.
 *
 * Records are named by the sha256 of the site id rather than by the id itself.
 * A named site's id ends in its {@code d} tag, which is arbitrary event data —
 * it can contain a slash — and the same hash is the shortcut id and the key in
 * the launch intent, so nothing an event says ever reaches a path.
 */
final class NsiteSites {

    /**
     * Named for what these records used to be — only pinned sites had them.
     * Left alone so that sites pinned before that changed keep their manifests.
     */
    private static final String DIRECTORY = "nsite-pinned";

    /** Squares of this size in the recents switcher; the icon is drawn at 4x that. */
    private static final int TASK_ICON_SIZE = 192;

    private NsiteSites() {}

    /** A record of a site that has a window of its own. */
    static final class Record {
        final String siteId;
        final String label;
        /** The NIP-5A manifest event, as JSON text. */
        final String event;

        Record(String siteId, String label, String event) {
            this.siteId = siteId;
            this.label = label;
            this.event = event;
        }
    }

    /**
     * The filesystem-safe, collision-free name for a site id.
     *
     * Also the shortcut id and the launch intent's URI, so that pinning the
     * same site twice replaces the shortcut rather than adding a second one.
     */
    @NonNull
    static String key(@NonNull String siteId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(siteId.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required of every Java platform; this cannot happen.
            throw new IllegalStateException(e);
        }
    }

    // -----------------------------------------------------------------------

    /**
     * Write a site's manifest and icon, replacing anything already there.
     *
     * Called when a site is opened, when it is pinned, and when it is
     * refreshed from the relay — so a site follows its publisher rather than
     * serving whatever it happened to be on the day its window was made.
     */
    static void save(
        Context context,
        @NonNull String siteId,
        @NonNull String label,
        @NonNull String event,
        @Nullable Bitmap icon
    ) throws IOException {
        File dir = directory(context);
        String key = key(siteId);

        JSONObject json = new JSONObject();
        try {
            json.put("siteId", siteId);
            json.put("label", label);
            json.put("event", event);
        } catch (JSONException e) {
            throw new IOException("Could not serialize pinned site", e);
        }

        write(new File(dir, key + ".json"), json.toString().getBytes(StandardCharsets.UTF_8));

        // Kept even though the launcher has its own copy: the icon is wanted
        // again on every cold start, for the recents card.
        if (icon != null) {
            try (OutputStream out = new FileOutputStream(new File(dir, key + ".png"))) {
                icon.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
        }
    }

    /**
     * Update a site's manifest, but only if it already has a record.
     *
     * The refresh runs unconditionally on the web side, which doesn't know
     * whether one exists; a site whose record has since been forgotten must
     * not gain another by being looked at.
     */
    static boolean refresh(
        Context context,
        @NonNull String siteId,
        @NonNull String label,
        @NonNull String event
    ) throws IOException {
        if (load(context, siteId) == null) return false;
        save(context, siteId, label, event, null);
        return true;
    }

    @Nullable
    static Record load(Context context, @NonNull String siteId) {
        File file = new File(directory(context), key(siteId) + ".json");
        if (!file.exists()) return null;

        try {
            JSONObject json = new JSONObject(new String(readFully(file), StandardCharsets.UTF_8));
            String event = json.optString("event", null);
            if (event == null) return null;
            return new Record(
                json.optString("siteId", siteId),
                json.optString("label", siteId),
                event
            );
        } catch (IOException | JSONException e) {
            // A truncated or hand-edited record is no record.
            return null;
        }
    }

    /**
     * Forget a site, manifest and icon both.
     *
     * A site opened from the channel wall keeps its record only as long as its
     * window does: the record is what the window is resumed from, and once the
     * window is gone the wall is how the site gets opened again. A pinned site
     * keeps its record whatever happens to the window — the shortcut is still
     * on the home screen, and pressing it must not need a relay.
     */
    static void forget(Context context, @NonNull String siteId) {
        File dir = directory(context);
        String key = key(siteId);
        //noinspection ResultOfMethodCallIgnored
        new File(dir, key + ".json").delete();
        //noinspection ResultOfMethodCallIgnored
        new File(dir, key + ".png").delete();
    }

    /**
     * The site's icon, scaled for a recents card.
     *
     * {@code TaskDescription} carries its bitmap across a binder transaction,
     * so it gets a small copy rather than the full-size artwork the launcher
     * was given.
     */
    @Nullable
    static Bitmap taskIcon(Context context, @NonNull String siteId) {
        File file = new File(directory(context), key(siteId) + ".png");
        if (!file.exists()) return null;

        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
        if (bitmap == null) return null;
        if (bitmap.getWidth() <= TASK_ICON_SIZE && bitmap.getHeight() <= TASK_ICON_SIZE) {
            return bitmap;
        }

        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, TASK_ICON_SIZE, TASK_ICON_SIZE, true);
        if (scaled != bitmap) bitmap.recycle();
        return scaled;
    }

    // -----------------------------------------------------------------------

    private static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** Write through a temp file, so a failed write leaves the old record intact. */
    private static void write(File destination, byte[] bytes) throws IOException {
        File temp = File.createTempFile("pinned", null, destination.getParentFile());
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
