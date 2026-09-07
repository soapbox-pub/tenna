package pub.soapbox.tenna;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * The apps already on the device, as things that can go on the wall.
 *
 * A launchable app is one whose manifest answers {@code MAIN}/{@code LAUNCHER}
 * — the same question the device's own home screen asks, which is why the
 * lineup here matches the one in the app drawer rather than the far longer
 * list of everything installed. Tenna declares that intent in {@code
 * <queries>}, so the package manager will answer it at all on Android 11 and
 * later.
 *
 * An app is identified by its package plus the activity that launches it,
 * because a package may publish more than one entry — a suite with a launcher
 * icon per tool is one package and several apps to the person looking at the
 * screen.
 */
final class NativeApps {

    /**
     * How large an icon is handed to the web layer.
     *
     * The tile it lands on is drawn at a quarter of a phone's width and can be
     * pressed into a launcher shortcut at full adaptive-icon size besides, so
     * this is sized for the larger use and left to scale down for the smaller.
     */
    private static final int ICON_PX = 192;

    private NativeApps() {}

    /** One launchable app, as the wall sees it. */
    static final class Entry {
        final String packageName;
        final String activityName;
        final String label;

        Entry(@NonNull String packageName, @NonNull String activityName, @NonNull String label) {
            this.packageName = packageName;
            this.activityName = activityName;
            this.label = label;
        }

        /** Stable across reinstalls and updates, unlike anything numeric. */
        @NonNull
        String id() {
            return packageName + "/" + activityName;
        }
    }

    /**
     * Every launchable app on the device, by name.
     *
     * Sorted with a {@link Collator} rather than by code point: the list is
     * read by a person scrolling it, and code-point order puts accented names
     * after {@code Z} in every language that has them.
     *
     * Tenna itself is left out. It is on the screen the list is being read
     * from, and a tile that launched the wall from the wall is a loop with
     * nothing at the end of it.
     */
    @NonNull
    static List<Entry> list(@NonNull Context context) {
        PackageManager pm = context.getPackageManager();

        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = pm.queryIntentActivities(query, 0);

        List<Entry> entries = new ArrayList<>(resolved.size());
        String self = context.getPackageName();

        for (ResolveInfo info : resolved) {
            if (info.activityInfo == null) continue;
            if (self.equals(info.activityInfo.packageName)) continue;

            CharSequence label = info.loadLabel(pm);
            String name = label == null ? "" : label.toString().trim();
            if (name.isEmpty()) name = info.activityInfo.packageName;

            entries.add(new Entry(info.activityInfo.packageName, info.activityInfo.name, name));
        }

        Collator collator = Collator.getInstance(Locale.getDefault());
        collator.setStrength(Collator.PRIMARY);
        Collections.sort(entries, (a, b) -> collator.compare(a.label, b.label));

        return entries;
    }

    /** The one entry matching a package and activity, or null if it is gone. */
    @Nullable
    static Entry find(@NonNull Context context, @NonNull String packageName, @Nullable String activityName) {
        for (Entry entry : list(context)) {
            if (!entry.packageName.equals(packageName)) continue;
            if (activityName == null || activityName.equals(entry.activityName)) return entry;
        }
        return null;
    }

    /**
     * An app's icon as a base64 PNG, without a data URL prefix.
     *
     * Already the shape the device draws it in, transparent around the edges,
     * and meant to be shown as-is. An app's icon is the app's own artwork in a
     * way an nsite's is not — it was drawn for this device, it is already on
     * this device's home screen, and cutting Tenna's squircle out of it would
     * turn Signal's circle into a rounded square and put a sheen of glass over
     * artwork that never asked for one.
     */
    @Nullable
    static String icon(@NonNull Context context, @NonNull String packageName, @Nullable String activityName) {
        Entry entry = find(context, packageName, activityName);
        if (entry == null) return null;

        Drawable drawable;
        try {
            drawable = context.getPackageManager().getActivityIcon(
                new android.content.ComponentName(entry.packageName, entry.activityName)
            );
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }

        return encode(rasterize(drawable));
    }

    /**
     * Launch an app.
     *
     * The component is named explicitly, so the app that opens is the one whose
     * tile was pressed and never a chooser. {@code NEW_TASK} because it must
     * land in a task of its own — the wall is not its parent, and pressing back
     * out of it should leave it where it was rather than fall into Tenna.
     */
    static boolean launch(@NonNull Context context, @NonNull String packageName, @Nullable String activityName) {
        Entry entry = find(context, packageName, activityName);

        Intent intent;
        if (entry != null) {
            intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new android.content.ComponentName(entry.packageName, entry.activityName));
        } else {
            // The activity moved but the package is still here — an update can
            // rename its launcher activity. Let the system pick the new one.
            intent = context.getPackageManager().getLaunchIntentForPackage(packageName);
            if (intent == null) return false;
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);

        try {
            context.startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /**
     * Open the system's own page for an app.
     *
     * What "App info" means for something Tenna did not build: permissions,
     * storage, notifications and the uninstall button all live on the OS
     * screen, and there is nothing Tenna could say about a native app that
     * would be worth showing instead.
     */
    static boolean settings(@NonNull Context context, @NonNull String packageName) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            context.startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /**
     * Hand a URI to whatever on the device answers for its scheme.
     *
     * The WebView would do this itself for a link it cannot navigate to, but
     * silently: an unhandled scheme is swallowed there, and a button that does
     * nothing is worse than one that says nothing happened. The answer comes
     * back so the caller can say so.
     *
     * The whole URI is the caller's to build. This starts a view intent for
     * whatever string it is given, which is only safe because the plugin is
     * registered on the wall's activity alone — a site's own window has no
     * route to it.
     */
    static boolean openUri(@NonNull Context context, @NonNull String uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            context.startActivity(intent);
            return true;
        } catch (android.content.ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    /**
     * Whatever the drawable is, as a bitmap of a known size, in the shape the
     * device would draw it.
     *
     * A legacy icon is already a picture with its own outline and transparency
     * around it, and is passed through. An adaptive one is not: it is two full
     * square layers, drawn oversized, that every launcher cuts a shape out of
     * before showing. Doing that here is what makes the two kinds comparable —
     * otherwise every modern icon on the wall would be a hard-edged square.
     */
    @NonNull
    private static Bitmap rasterize(@NonNull Drawable drawable) {
        if (drawable instanceof BitmapDrawable) {
            Bitmap bitmap = ((BitmapDrawable) drawable).getBitmap();
            if (bitmap != null && !bitmap.isRecycled()) {
                return Bitmap.createScaledBitmap(bitmap, ICON_PX, ICON_PX, true);
            }
        }

        Bitmap out = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        drawable.setBounds(0, 0, ICON_PX, ICON_PX);
        drawable.draw(new Canvas(out));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable instanceof AdaptiveIconDrawable) {
            return cut(out, iconMask((AdaptiveIconDrawable) drawable));
        }

        return out;
    }

    /**
     * The shape this device cuts its adaptive icons into.
     *
     * The system exposes its own mask from Android 13, which is the right
     * answer wherever it can be had — a device themed to circles and a device
     * themed to squircles should not both get Tenna's idea of the shape. Below
     * that the mask is only reachable through a hidden resource, so the
     * platform's default stands in; a circle is the shape the adaptive icon
     * spec is drawn against, and every icon is designed to survive it.
     */
    @Nullable
    private static Path iconMask(@NonNull AdaptiveIconDrawable drawable) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Path mask = drawable.getIconMask();
            if (mask != null && !mask.isEmpty()) return mask;
        }
        return null;
    }

    /** The artwork with everything outside the mask taken away. */
    @NonNull
    private static Bitmap cut(@NonNull Bitmap source, @Nullable Path mask) {
        Bitmap out = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);

        // Painted first and drawn through, rather than clipped: a clip path is
        // not antialiased, and an icon with a stair-stepped edge is worse than
        // no shape at all.
        if (mask != null) canvas.drawPath(mask, paint);
        else canvas.drawCircle(ICON_PX / 2f, ICON_PX / 2f, ICON_PX / 2f, paint);

        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(source, 0, 0, paint);

        source.recycle();
        return out;
    }

    @NonNull
    private static String encode(@NonNull Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        bitmap.recycle();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
