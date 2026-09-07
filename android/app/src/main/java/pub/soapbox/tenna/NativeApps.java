package pub.soapbox.tenna;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

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

    /**
     * One app's artwork, and what shape it arrived in.
     *
     * The two kinds of icon Android has are not the same object. An adaptive
     * one is a square canvas meant to be cut; a legacy one is a finished
     * picture that has already been cut, by whoever drew it. Only the caller
     * knows which of those it can put behind a squircle, so it is told.
     */
    static final class Art {
        /** Base64 PNG, without a data URL prefix. */
        final String png;
        /** Whether the artwork is a full square, with a shape still to cut. */
        final boolean adaptive;

        Art(@NonNull String png, boolean adaptive) {
            this.png = png;
            this.adaptive = adaptive;
        }
    }

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
     * An app's icon, uncut.
     *
     * An adaptive icon comes back as the whole square its two layers are drawn
     * on, with no mask applied. Which shape this device would have cut out of
     * it is the device's business, and the wall is not the device: taking the
     * host's mask would make Tenna a home screen of circles on one phone and
     * of squircles on the next, and neither would match the nsites sitting
     * beside them. The shape is cut where every other tile's is — in the web
     * layer, once, the same way for all of them.
     *
     * A legacy icon has no square to cut. It is a finished picture with its
     * own outline and transparency around it, so it is passed through and said
     * to be what it is.
     */
    @Nullable
    static Art icon(@NonNull Context context, @NonNull String packageName, @Nullable String activityName) {
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

        boolean adaptive = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && drawable instanceof AdaptiveIconDrawable;

        return new Art(encode(rasterize(drawable)), adaptive);
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

    /** Whatever the drawable is, as a bitmap of a known size, uncut. */
    @NonNull
    private static Bitmap rasterize(@NonNull Drawable drawable) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable instanceof AdaptiveIconDrawable) {
            return layers((AdaptiveIconDrawable) drawable);
        }

        if (drawable instanceof BitmapDrawable) {
            Bitmap bitmap = ((BitmapDrawable) drawable).getBitmap();
            if (bitmap != null && !bitmap.isRecycled()) {
                return Bitmap.createScaledBitmap(bitmap, ICON_PX, ICON_PX, true);
            }
        }

        Bitmap out = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        drawable.setBounds(0, 0, ICON_PX, ICON_PX);
        drawable.draw(new Canvas(out));
        return out;
    }

    /**
     * An adaptive icon's two layers, painted straight onto a square.
     *
     * Not the drawable itself. {@link AdaptiveIconDrawable#draw} paints its
     * layers *through its own mask* — rendering it is how a circle is
     * produced, not how one is avoided — so asking it to draw and then not
     * masking the result gets the host's shape anyway, baked in and no longer
     * removable.
     *
     * The layers underneath have no shape at all. They are the oversized
     * canvas the mask is cut from: {@code 108dp} of artwork behind a
     * {@code 72dp} viewport, a quarter of the viewport bleeding past it on
     * every side. Drawn at those bounds, what lands on the bitmap is exactly
     * the square a launcher would have cut, and the cutting is left to Tenna.
     */
    @NonNull
    @RequiresApi(Build.VERSION_CODES.O)
    private static Bitmap layers(@NonNull AdaptiveIconDrawable drawable) {
        Bitmap out = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);

        int bleed = Math.round(ICON_PX * AdaptiveIconDrawable.getExtraInsetFraction());
        Rect bounds = new Rect(-bleed, -bleed, ICON_PX + bleed, ICON_PX + bleed);

        // Background first, then foreground. Either may be missing — the spec
        // requires neither — and an icon with no background is one whose
        // corners the tile's own color shows through.
        for (Drawable layer : new Drawable[] { drawable.getBackground(), drawable.getForeground() }) {
            if (layer == null) continue;
            layer.setBounds(bounds);
            layer.draw(canvas);
        }

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
