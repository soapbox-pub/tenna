package pub.soapbox.tenna;

import android.content.Context;
import android.graphics.Bitmap;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.drawable.IconCompat;

/**
 * The stencil that goes in the status bar, and under the site's name in the
 * shade.
 *
 * The standard calls it {@code badge}: the image that stands for a
 * notification "when there is not enough space to display the notification
 * itself, such as a device's notification bar". That is Android's small icon
 * exactly, and it is the one place a site can put its own mark on the system
 * rather than borrowing Tenna's. Every notification used to wear
 * {@code ic_stat_napp}, so a shade with three sites in it was three
 * televisions.
 *
 * Three answers, in order:
 *
 * <ol>
 *   <li>The <b>notification's own {@code badge}</b>, resolved the way every
 *       other picture is — a path out of the site's blobs, an https URL, or a
 *       {@code data:} URL. A site that draws one per kind of notification gets
 *       one per kind.
 *   <li>The site's <b>monochrome web app manifest icon</b>, the artwork a site
 *       already declares for exactly this purpose. Picked and rendered on the
 *       channel wall, where the manifest is read, and stored beside the site's
 *       tile — see {@code appBadgeBitmap.ts}.
 *   <li><b>Tenna's own</b>, for a site that has neither.
 * </ol>
 *
 * Whatever the source, it comes out white over its own alpha. A small icon is
 * a silhouette; the system picks the colour, and artwork handed over in full
 * colour arrives as a blob.
 */
final class NappBadges {

    private NappBadges() {}

    /**
     * The small icon for one of a site's notifications, or null to use
     * Tenna's.
     *
     * Never waits. A badge still being fetched returns whatever is further
     * down the chain, and {@code again} fires when it lands so the
     * notification can be posted a second time wearing it — the same bargain
     * every other picture makes here.
     */
    @Nullable
    static IconCompat icon(
        @NonNull Context context,
        @NonNull String siteId,
        @Nullable String reference,
        @Nullable NappImages.OnLoaded again
    ) {
        if (reference != null) {
            Bitmap badge = NappImages.cached(
                context, siteId, reference, NappImages.SHAPE_STENCIL, again
            );
            if (badge != null) return IconCompat.createWithBitmap(badge);
        }

        return site(context, siteId);
    }

    /**
     * The site's own mark, with no notification behind it.
     *
     * What the group summary wears, since a summary stands for the site rather
     * than for anything it said.
     */
    @Nullable
    static IconCompat site(@NonNull Context context, @NonNull String siteId) {
        Bitmap stored = NsiteSites.badge(context, siteId);
        if (stored == null) return null;

        // Scaled here rather than on the way in: the stored artwork is kept at
        // the size the site published it, and what the status bar wants
        // depends on the density of a screen the wall never asked about.
        int size = NappImages.stencilPx(context);
        Bitmap scaled = stored.getWidth() == size && stored.getHeight() == size
            ? stored
            : Bitmap.createScaledBitmap(stored, size, size, true);
        if (scaled != stored) stored.recycle();

        return IconCompat.createWithBitmap(NappImages.stencil(scaled));
    }
}
