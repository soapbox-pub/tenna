package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;

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
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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

    /** Squares of this size wherever the icon is handed across a binder. */
    private static final int TASK_ICON_SIZE = 192;

    /**
     * The share of an adaptive canvas that is the icon: 72dp of the 108.
     *
     * The stored PNG is drawn to that spec — see {@code appIconBitmap} — so
     * the outer ring of it is margin for the launcher's mask and parallax
     * rather than part of the picture.
     */
    private static final float VIEWPORT = 72f / 108f;

    private NsiteSites() {}

    /** A record of a site that has a window of its own. */
    static final class Record {
        final String siteId;
        final String label;
        /** The NIP-5A manifest event, as JSON text. */
        final String event;
        /**
         * The site's web app manifest {@code share_target}, as JSON text, or
         * null if it declared none.
         *
         * Kept opaque on purpose. It is read and checked once, in the web
         * layer, and nothing here has any business interpreting it — a second
         * parser would be a second set of rules about what a site may ask for.
         */
        @Nullable final String shareTarget;

        Record(String siteId, String label, String event, @Nullable String shareTarget) {
            this.siteId = siteId;
            this.label = label;
            this.event = event;
            this.shareTarget = shareTarget;
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
        @Nullable Bitmap icon,
        @Nullable Bitmap badge,
        @Nullable String shareTarget
    ) throws IOException {
        if (!NsiteOrigins.isSiteId(siteId)) {
            throw new IOException("Not a site id: " + siteId);
        }

        File dir = directory(context);
        String key = key(siteId);

        // Null is "don't know", not "hasn't got one": only the channel wall
        // ever reads a site's web app manifest, so a caller that hasn't been
        // there must leave what is already stored alone. The wall says a site
        // has no share target by sending an empty string.
        String share = shareTarget == null
            ? shareTarget(context, siteId)
            : (shareTarget.isEmpty() ? null : shareTarget);

        JSONObject json = new JSONObject();
        try {
            json.put("siteId", siteId);
            json.put("label", label);
            json.put("event", event);
            if (share != null) json.put("shareTarget", share);
        } catch (JSONException e) {
            throw new IOException("Could not serialize pinned site", e);
        }

        write(new File(dir, key + ".json"), json.toString().getBytes(StandardCharsets.UTF_8));
        NsiteFileServers.invalidate(siteId);

        // Kept even though the launcher has its own copy: the icon is wanted
        // again on every cold start, for the recents card.
        if (icon != null) {
            try (OutputStream out = new FileOutputStream(new File(dir, key + ".png"))) {
                icon.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
        }

        // The site's monochrome manifest icon, for the status bar. Written
        // here for the same reason the tile is: a notification can arrive for
        // a site with no window open and nothing of the wall's in memory, and
        // the manifest it was picked out of is only ever read on the wall.
        if (badge != null) {
            try (OutputStream out = new FileOutputStream(new File(dir, key + ".badge.png"))) {
                badge.compress(Bitmap.CompressFormat.PNG, 100, out);
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
        save(context, siteId, label, event, null, null, null);
        return true;
    }

    @Nullable
    static Record load(Context context, @NonNull String siteId) {
        return read(new File(directory(context), key(siteId) + ".json"), siteId);
    }

    /** Every site with a record, in no particular order. */
    @NonNull
    static List<Record> list(Context context) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return Collections.emptyList();

        List<Record> records = new ArrayList<>(files.length);
        for (File file : files) {
            Record record = read(file, null);
            if (record != null) records.add(record);
        }
        return records;
    }

    /**
     * The {@link #key} of every site with a record.
     *
     * The names off the directory, with nothing read or parsed. For a caller
     * that only needs to know which sites still exist — {@link
     * NsiteProfiles#sweep} — and runs where the cost of opening every record
     * would be paid before the first window could be drawn.
     */
    @NonNull
    static Set<String> keys(Context context) {
        String[] names = directory(context).list((dir, name) -> name.endsWith(".json"));
        if (names == null) return Collections.emptySet();

        Set<String> keys = new HashSet<>(names.length);
        for (String name : names) {
            keys.add(name.substring(0, name.length() - ".json".length()));
        }
        return keys;
    }

    /** What a site said it would take from the share sheet, if anything. */
    @Nullable
    static String shareTarget(Context context, @NonNull String siteId) {
        Record record = load(context, siteId);
        return record == null ? null : record.shareTarget;
    }

    /**
     * Record what a site will take from the share sheet, on a record it has.
     *
     * Its own entry point because the channel wall learns this about a site
     * long after the site was opened or pinned — a site put on the home screen
     * before Tenna read share targets at all has a record with nothing in that
     * field, and would go on having one until the day it was opened again.
     *
     * An empty string clears it, which is how a site that has since dropped
     * the member loses its place in the sheet.
     */
    static boolean setShareTarget(
        Context context,
        @NonNull String siteId,
        @NonNull String shareTarget
    ) throws IOException {
        Record record = load(context, siteId);
        if (record == null) return false;

        String current = record.shareTarget;
        String next = shareTarget.isEmpty() ? null : shareTarget;
        if (current == null ? next == null : current.equals(next)) return false;

        save(context, siteId, record.label, record.event, null, null, shareTarget);
        return true;
    }

    /**
     * The site's monochrome mark, as it was stored, or null if it has none.
     *
     * Raw artwork rather than a finished stencil: what the status bar wants
     * depends on the density of the screen it is on, and the wall that drew
     * this never asked. {@link NappBadges} sizes and paints it.
     */
    @Nullable
    static Bitmap badge(Context context, @NonNull String siteId) {
        File file = new File(directory(context), key(siteId) + ".badge.png");
        if (!file.exists()) return null;
        return BitmapFactory.decodeFile(file.getAbsolutePath());
    }

    @Nullable
    private static Record read(File file, @Nullable String siteId) {
        if (!file.exists()) return null;

        try {
            JSONObject json = new JSONObject(new String(readFully(file), StandardCharsets.UTF_8));
            String event = json.optString("event", null);
            String id = json.optString("siteId", siteId);
            if (event == null || id == null) return null;
            // The one gate every reader of a record passes through. An id that
            // is not a DNS label cannot be turned into an origin — see
            // NsiteOrigins — and a record holding one was either written by a
            // build that did not check or was not written by this app.
            if (!NsiteOrigins.isSiteId(id)) return null;
            return new Record(
                id,
                json.optString("label", id),
                event,
                json.optString("shareTarget", null)
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
        //noinspection ResultOfMethodCallIgnored
        new File(dir, key + ".badge.png").delete();
        NsiteFileServers.invalidate(siteId);
    }

    /**
     * The site's icon as the launcher wants it: a whole adaptive canvas.
     *
     * Only for a caller handing the bitmap to {@code ShortcutManager}, which
     * takes it as an adaptive icon's layer and does the cropping and the
     * masking itself. Anything that draws the icon rather than delegating it
     * wants {@link #taskIcon} or {@link #tileIcon} instead — this one is
     * two thirds picture and one third margin.
     */
    @Nullable
    static Bitmap adaptiveIcon(Context context, @NonNull String siteId) {
        Bitmap stored = stored(context, siteId);
        if (stored == null) return null;
        if (stored.getWidth() <= TASK_ICON_SIZE && stored.getHeight() <= TASK_ICON_SIZE) {
            return stored;
        }

        Bitmap scaled = Bitmap.createScaledBitmap(stored, TASK_ICON_SIZE, TASK_ICON_SIZE, true);
        if (scaled != stored) stored.recycle();
        return scaled;
    }

    /** A site's icon and the colour it was standing on when it was cut out. */
    static final class TaskIcon {
        final Bitmap bitmap;
        final int color;

        private TaskIcon(Bitmap bitmap, int color) {
            this.bitmap = bitmap;
            this.color = color;
        }
    }

    /**
     * The site's icon as a finished picture, cut to the platform's icon shape.
     *
     * For a slot that draws a bitmap into a round hole and rounds nothing
     * itself: the recents card and a notification's large icon. Handed the
     * stored canvas whole they show the icon at half size, because the
     * switcher inserts every task icon into an adaptive one of its own at a
     * fixed scale — so a canvas already inset for a mask is inset a second
     * time. Cropping to the viewport spends that inset once instead of twice.
     *
     * The shrink itself is not ours to refuse, which is what {@link #color}
     * is for: the switcher fills the circle behind the icon with the task's
     * primary colour, so telling it the colour the mask cut into turns a
     * picture floating in a dark disc into one icon on its own field.
     */
    @Nullable
    static TaskIcon taskIcon(Context context, @NonNull String siteId) {
        Bitmap tile = tileIcon(context, siteId);
        if (tile == null) return null;

        // Read before the mask, which recycles what it cuts.
        int color = corners(tile);
        return new TaskIcon(mask(tile), color);
    }

    /**
     * The same picture, left square, for a caller that clips its own corners.
     *
     * The in-app share picker draws it into a squircle of its own; cutting it
     * to the launcher's circle first would leave the tile's gradient showing
     * through the corners.
     */
    @Nullable
    static Bitmap tileIcon(Context context, @NonNull String siteId) {
        Bitmap stored = stored(context, siteId);
        if (stored == null) return null;

        Rect source = new Rect(
            Math.round((stored.getWidth() * (1 - VIEWPORT)) / 2f),
            Math.round((stored.getHeight() * (1 - VIEWPORT)) / 2f),
            Math.round((stored.getWidth() * (1 + VIEWPORT)) / 2f),
            Math.round((stored.getHeight() * (1 + VIEWPORT)) / 2f)
        );

        Bitmap cropped = Bitmap.createBitmap(
            TASK_ICON_SIZE,
            TASK_ICON_SIZE,
            Bitmap.Config.ARGB_8888
        );

        new Canvas(cropped).drawBitmap(
            stored,
            source,
            new Rect(0, 0, TASK_ICON_SIZE, TASK_ICON_SIZE),
            new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG)
        );

        stored.recycle();
        return cropped;
    }

    // -----------------------------------------------------------------------

    @Nullable
    private static Bitmap stored(Context context, @NonNull String siteId) {
        File file = new File(directory(context), key(siteId) + ".png");
        if (!file.exists()) return null;
        return BitmapFactory.decodeFile(file.getAbsolutePath());
    }

    /**
     * The colour in the four corners of a square, which is the colour the
     * icon mask is about to cut away.
     *
     * Averaged rather than sampled, because a tile drawn as a gradient has no
     * one corner colour; opaque whatever it finds, since it is going behind
     * the icon rather than over it.
     */
    private static int corners(@NonNull Bitmap square) {
        int right = square.getWidth() - 1;
        int bottom = square.getHeight() - 1;

        int[] pixels = {
            square.getPixel(0, 0),
            square.getPixel(right, 0),
            square.getPixel(0, bottom),
            square.getPixel(right, bottom),
        };

        int red = 0;
        int green = 0;
        int blue = 0;
        for (int pixel : pixels) {
            red += Color.red(pixel);
            green += Color.green(pixel);
            blue += Color.blue(pixel);
        }

        return Color.rgb(red / pixels.length, green / pixels.length, blue / pixels.length);
    }

    /** The square cut to {@link #iconMask}, or left alone where there is none. */
    @Nullable
    private static Bitmap mask(@Nullable Bitmap square) {
        if (square == null) return null;

        Path shape = iconMask(square.getWidth(), square.getHeight());
        if (shape == null) return square;

        Bitmap cut = Bitmap.createBitmap(
            square.getWidth(),
            square.getHeight(),
            Bitmap.Config.ARGB_8888
        );

        Canvas canvas = new Canvas(cut);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        canvas.drawPath(shape, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(square, 0, 0, paint);

        square.recycle();
        return cut;
    }

    /**
     * The shape this device cuts an app icon to, at the given size.
     *
     * Read off the platform rather than assumed to be a circle, because it is
     * a device configuration and the recents switcher compares against the
     * same one. Null before adaptive icons existed, where there is no shape to
     * cut to and nothing that would cut one.
     */
    @Nullable
    private static Path iconMask(int width, int height) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null;

        AdaptiveIconDrawable shape = new AdaptiveIconDrawable(
            new ColorDrawable(Color.BLACK),
            new ColorDrawable(Color.BLACK)
        );
        shape.setBounds(0, 0, width, height);

        Path mask = new Path(shape.getIconMask());
        return mask.isEmpty() ? null : mask;
    }

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
