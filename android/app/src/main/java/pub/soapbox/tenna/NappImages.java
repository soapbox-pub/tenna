package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.util.LruCache;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pictures for a notification: the icon beside it, the stencil in the status
 * bar, the photograph it expands into.
 *
 * Three kinds of reference, in the order a site should reach for them:
 *
 * <ul>
 *   <li>A <b>site-absolute path</b> — {@code /icon-192.png}. Resolved against
 *       the site's own NIP-5A manifest and served out of the content-addressed
 *       blob cache, so it costs nothing after the first time, works with the
 *       radio off, and reaches no network this process didn't already trust.
 *       This is the good one.
 *   <li>An <b>https URL</b> — unavoidable for a user's avatar, which lives on
 *       whatever host their profile names. Fetched here rather than in the
 *       WebView, so it is deliberately hobbled: https only, no redirect off
 *       https, no cookies, an image content type, a size ceiling and a short
 *       timeout. It still tells that host the device is here, which is the
 *       price of showing a face.
 *   <li>A <b>{@code data:} URL</b>, for a site that would rather do its own
 *       fetching and downscaling. Cheap, but it is spent out of the same
 *       64 KiB the notification's words come from.
 * </ul>
 *
 * Nothing here blocks a notification. {@link #cached} is what the builder
 * calls on the way to posting; a miss returns null and starts the work, and
 * the notification is posted again, silently, when the picture lands. That
 * ordering is the whole trick — a face is worth having, and never worth
 * waiting for.
 */
final class NappImages {

    private static final String TAG = "NappImages";

    /** A big picture is drawn wide. Android's own ceiling is around this. */
    private static final int PICTURE_PX = 1024;

    /** The status bar draws its icons at 24dp. */
    private static final int STENCIL_DP = 24;

    /** Faces are drawn small; anything larger is a waste of a binder. */
    private static final int AVATAR_PX = 256;

    /**
     * As decoded, at the size it was declared for.
     *
     * Left square. Android clips a large icon to its own shape in the shade,
     * and a picture cropped round here would be cropped twice.
     */
    static final int SHAPE_PLAIN = 0;

    /**
     * Flattened to white over its own alpha, for the status bar.
     *
     * A small icon is a stencil: the shape is what carries, and the colour is
     * the system's to choose. Painting the artwork white here rather than
     * hoping the framework masks it is what Chrome does with a web
     * notification's badge, and it is the only thing that looks right on every
     * version — a full-colour bitmap in that slot comes out as a smudge.
     */
    static final int SHAPE_STENCIL = 1;

    /**
     * A square crop of the middle, cut to a circle.
     *
     * For the face on the left of a conversation notification, and the
     * shortcut icon behind it. The system masks that slot on most builds and
     * on some it does not, so cutting it here is the only way to be sure a
     * portrait doesn't arrive with somebody's shoulders squashed into a box.
     */
    static final int SHAPE_ROUND = 2;

    /** A remote image bigger than this is not a notification icon. */
    private static final int MAX_BYTES = 2 * 1024 * 1024;

    private static final int MAX_CACHED = 64;

    /**
     * One thread. A burst of notifications wants its faces in the order they
     * were asked for, not all at once against the same handful of hosts.
     */
    private static final ExecutorService WORKERS = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "napp-images");
        t.setDaemon(true);
        return t;
    });

    private static final LruCache<String, Bitmap> CACHE = new LruCache<>(MAX_CACHED);

    /** References already being fetched, so a burst asks for a face once. */
    private static final java.util.Set<String> IN_FLIGHT =
        java.util.Collections.synchronizedSet(new java.util.HashSet<>());

    interface OnLoaded {
        void onLoaded();
    }

    private NappImages() {}

    /**
     * The picture for a reference if it is already to hand, or null.
     *
     * A null starts the work and calls {@code onLoaded} once, on a background
     * thread, when there is something new to draw. It is not called for a
     * reference that turns out to be unreachable — a notification that has
     * already been posted without a face is not improved by being posted again
     * without one.
     */
    @Nullable
    static Bitmap cached(
        @NonNull Context context,
        @NonNull String siteId,
        @Nullable String reference,
        int shape,
        @Nullable OnLoaded onLoaded
    ) {
        if (reference == null) return null;

        String key = key(siteId, reference, shape);
        Bitmap hit;
        synchronized (CACHE) {
            hit = CACHE.get(key);
        }
        if (hit != null) return hit;

        if (!IN_FLIGHT.add(key)) return null;

        Context app = context.getApplicationContext();
        WORKERS.execute(() -> {
            Bitmap bitmap = null;
            try {
                bitmap = load(app, siteId, reference, shape);
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not decode an image for " + siteId, e);
            } finally {
                IN_FLIGHT.remove(key);
            }

            if (bitmap == null) return;
            synchronized (CACHE) {
                CACHE.put(key, bitmap);
            }
            if (onLoaded != null) onLoaded.onLoaded();
        });

        return null;
    }

    private static String key(String siteId, String reference, int shape) {
        // Only a path is scoped to the site; two sites naming the same URL are
        // naming the same bytes.
        String scope = reference.startsWith("/") ? NsiteSites.key(siteId) : "";
        return scope + "|" + shape + "|" + reference;
    }

    // -----------------------------------------------------------------------

    @Nullable
    private static Bitmap load(Context context, String siteId, String reference, int shape) {
        byte[] bytes;

        if (reference.startsWith("data:")) {
            bytes = dataUrl(reference);
        } else if (reference.startsWith("/")) {
            bytes = fromSite(context, siteId, reference);
        } else {
            bytes = fromNetwork(reference);
        }

        if (bytes == null) return null;

        Bitmap decoded = decode(bytes, target(context, shape));
        if (decoded == null) return null;

        switch (shape) {
            case SHAPE_STENCIL: return stencil(decoded);
            case SHAPE_ROUND: return circle(decoded);
            default: return decoded;
        }
    }

    /** The longest edge a shape is worth decoding to. */
    private static int target(Context context, int shape) {
        switch (shape) {
            case SHAPE_STENCIL: return stencilPx(context);
            case SHAPE_ROUND: return AVATAR_PX;
            default: return PICTURE_PX;
        }
    }

    /** A square crop of the middle, cut to a circle. */
    @NonNull
    private static Bitmap circle(@NonNull Bitmap source) {
        int size = Math.min(source.getWidth(), source.getHeight());
        Rect from = new Rect(
            (source.getWidth() - size) / 2,
            (source.getHeight() - size) / 2,
            (source.getWidth() + size) / 2,
            (source.getHeight() + size) / 2
        );

        Bitmap out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);

        canvas.drawCircle(AVATAR_PX / 2f, AVATAR_PX / 2f, AVATAR_PX / 2f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(source, from, new Rect(0, 0, AVATAR_PX, AVATAR_PX), paint);

        source.recycle();
        return out;
    }

    static int stencilPx(@NonNull Context context) {
        float density = context.getResources().getDisplayMetrics().density;
        return Math.max(STENCIL_DP, Math.round(STENCIL_DP * density));
    }

    /**
     * The artwork painted white, with its own alpha kept.
     *
     * Everything opaque becomes white and everything transparent stays
     * transparent, so whatever the site drew arrives in the status bar as its
     * silhouette. A badge that is already a white-on-transparent stencil — the
     * shape the standard asks for — passes through unchanged.
     */
    @NonNull
    static Bitmap stencil(@NonNull Bitmap source) {
        Bitmap out = Bitmap.createBitmap(
            source.getWidth(),
            source.getHeight(),
            Bitmap.Config.ARGB_8888
        );

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        paint.setColorFilter(new PorterDuffColorFilter(Color.WHITE, PorterDuff.Mode.SRC_ATOP));
        new Canvas(out).drawBitmap(source, 0, 0, paint);

        source.recycle();
        return out;
    }

    /** The bytes of one of the site's own files, straight out of the blob cache. */
    @Nullable
    private static byte[] fromSite(Context context, String siteId, String path) {
        NsiteFileServer server = NsiteFileServers.resolve(context, NsiteOrigins.hostFor(siteId));
        if (server == null) return null;

        NsiteFileServer.Response response = server.serve(
            Uri.parse(NsiteOrigins.originFor(siteId) + path),
            null
        );

        try {
            // A path the manifest doesn't name falls through to the site's own
            // document, which is a perfectly good response and not a picture.
            if (response.status != 200 || !response.mimeType.startsWith("image/")) return null;
            return readFully(response.body, MAX_BYTES);
        } catch (IOException e) {
            return null;
        } finally {
            try {
                response.body.close();
            } catch (IOException ignored) {
                // Nothing left to do about it.
            }
        }
    }

    /**
     * The bytes behind an https URL, fetched with as little of the device's
     * identity attached as a plain connection can manage.
     *
     * No redirects are followed, rather than following them and checking:
     * a 301 to {@code http://} or to a private address is the interesting
     * case, and refusing the whole class costs a site nothing it can't fix by
     * naming the final URL.
     */
    @Nullable
    private static byte[] fromNetwork(String reference) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(reference);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return null;

            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(8_000);
            connection.setRequestProperty("Accept", "image/*");
            // Nothing of the user's goes out with it.
            connection.setRequestProperty("Cookie", "");
            connection.setRequestProperty("Referer", "");

            if (connection.getResponseCode() != 200) return null;

            String type = connection.getContentType();
            if (type == null || !type.toLowerCase().startsWith("image/")) return null;
            if (connection.getContentLength() > MAX_BYTES) return null;

            try (InputStream in = connection.getInputStream()) {
                return readFully(in, MAX_BYTES);
            }
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Nullable
    private static byte[] dataUrl(String reference) {
        int comma = reference.indexOf(',');
        if (comma < 0) return null;

        String head = reference.substring(0, comma);
        if (!head.endsWith(";base64")) return null;

        try {
            return Base64.decode(reference.substring(comma + 1), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Decode no larger than needed, in two passes, so a big JPEG can't OOM us. */
    @Nullable
    private static Bitmap decode(byte[] bytes, int target) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);

        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        if (longest <= 0) return null;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = Math.max(1, Integer.highestOneBit(longest / Math.max(1, target)));

        Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (decoded == null) return null;

        longest = Math.max(decoded.getWidth(), decoded.getHeight());
        if (longest <= target) return decoded;

        float scale = (float) target / longest;
        Bitmap scaled = Bitmap.createScaledBitmap(
            decoded,
            Math.max(1, Math.round(decoded.getWidth() * scale)),
            Math.max(1, Math.round(decoded.getHeight() * scale)),
            true
        );
        if (scaled != decoded) decoded.recycle();
        return scaled;
    }

    @NonNull
    private static byte[] readFully(@NonNull InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(16 * 1024);
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) {
            if (out.size() + read > limit) throw new IOException("Image too large");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
