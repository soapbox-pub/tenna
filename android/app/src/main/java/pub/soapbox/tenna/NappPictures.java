package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * A notification's {@code image}, as a file the shade can read.
 *
 * A photograph goes into a site's conversation the way a photograph goes into
 * any chat on the platform: as a message whose body is a picture rather than
 * words, which {@code MessagingStyle.Message.setData} takes as a {@code
 * content://} URI. A bitmap will not do — the message carries a reference, and
 * whoever draws it opens it themselves.
 *
 * So the decoded picture is written once into the cache and handed over
 * through Tenna's {@code FileProvider}. Nothing is granted explicitly: the
 * platform walks a notification's URIs on the way past and gives its own
 * listeners read access to what it finds, which is the whole reason the
 * message carries a reference in the first place.
 *
 * A miss is not a failure. Returning null puts the notification in the
 * conversation without its photograph, which is exactly what a picture that
 * never downloaded does — the site still said what it said.
 */
final class NappPictures {

    private static final String TAG = "NappPictures";

    private static final String DIRECTORY = "napp-pictures";

    /**
     * Pictures kept on disk at once.
     *
     * One per notification in the shade, and a site rarely has more than a
     * few out, so this is a margin rather than a gallery. Evicted
     * least-recently-shown first.
     */
    private static final int MAX_FILES = 16;

    private NappPictures() {}

    /**
     * The site's picture as a URI, or null if there isn't one to be had.
     *
     * Waits no longer than the notification's own deadline, like every other
     * picture, and calls {@code again} when a late one lands — a photograph,
     * unlike a face, is picked up by a repost.
     */
    @Nullable
    static Uri uri(
        @NonNull Context context,
        @NonNull String siteId,
        @Nullable String reference,
        long deadline,
        @Nullable NappImages.OnLoaded again
    ) {
        if (reference == null) return null;

        // Resolved before anything is locked: this is the part that can take
        // two seconds, and it is the part two notifications share anyway.
        Bitmap picture = NappImages.awaited(
            context, siteId, reference, NappImages.SHAPE_PLAIN, deadline, again
        );
        if (picture == null) return null;

        File file = store(context, siteId, reference, picture);
        if (file == null) return null;

        try {
            return FileProvider.getUriForFile(
                context, context.getPackageName() + ".fileprovider", file
            );
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not hand over a picture for " + siteId, e);
            return null;
        }
    }

    /**
     * The picture on disk, written if it isn't there already.
     *
     * One at a time, so the notification being posted and the one being posted
     * again behind a late face cannot write the same file at once. A reader
     * only ever arrives after the notification naming the file has been
     * posted, which is after this has returned.
     */
    @Nullable
    private static synchronized File store(
        Context context,
        String siteId,
        String reference,
        Bitmap picture
    ) {
        // Transparency is worth a bigger file; a photograph is not.
        boolean alpha = picture.hasAlpha();
        File file = new File(directory(context), name(siteId, reference) + (alpha ? ".png" : ".jpg"));

        try {
            if (!file.exists()) {
                try (OutputStream out = new FileOutputStream(file)) {
                    boolean written = picture.compress(
                        alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG,
                        alpha ? 100 : 90,
                        out
                    );
                    if (!written) throw new IOException("Could not encode a picture");
                }
            }

            // Touched on every use, so what is evicted is what nothing has
            // shown for longest rather than what was fetched longest ago.
            //noinspection ResultOfMethodCallIgnored
            file.setLastModified(System.currentTimeMillis());
            evict(context);
            return file;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "Could not lay out a picture for " + siteId, e);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return null;
        }
    }

    /** The mime type {@link #uri} wrote, which the message has to declare. */
    @NonNull
    static String mimeType(@NonNull Uri uri) {
        return uri.toString().endsWith(".png") ? "image/png" : "image/jpeg";
    }

    // -----------------------------------------------------------------------

    /** Keep the directory small, oldest out first. */
    private static void evict(Context context) {
        File[] files = directory(context).listFiles();
        if (files == null || files.length <= MAX_FILES) return;

        java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < files.length - MAX_FILES; i++) {
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    /**
     * A file name for a picture, scoped the way the image cache scopes it: a
     * path belongs to one site, a URL belongs to whoever serves it.
     */
    private static String name(String siteId, String reference) {
        String scope = reference.startsWith("/") ? NsiteSites.key(siteId) : "";

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((scope + "|" + reference).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(32);
            for (int i = 0; i < 16; i++) hex.append(String.format("%02x", hash[i]));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required of every Java platform; this cannot happen.
            throw new IllegalStateException(e);
        }
    }

    private static File directory(Context context) {
        File dir = new File(context.getCacheDir(), DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }
}
