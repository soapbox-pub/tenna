package pub.soapbox.tenna;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Draws the clock and the gesture pill for whatever a site puts behind them.
 *
 * A site in a window of its own has no bar of Tenna's over it, so the system
 * bars sit on the site's own pixels and something has to decide whether they
 * are drawn black or white. Two things answer, in this order:
 *
 * <ol>
 *   <li><b>What the site declared.</b> {@code theme-color} is the standard way
 *       a document names the colour of the chrome beside it, and the browser
 *       picking a readable foreground from it is what Chrome does for its own
 *       toolbar and for an installed web app. It is the only answer available
 *       before the site has painted anything, and it arrives with the document
 *       — early enough that the first frame is never wrong by default.
 *   <li><b>What the site painted.</b> Once there are pixels they are sampled,
 *       and they win. A declaration is a promise about a colour, and promises
 *       are broken: of the sites on one ordinary wall, three of five declared
 *       a dark colour while painting white. Worse, a declaration is read once
 *       off the served HTML and is a lie the moment the site's own theme
 *       switch is used, or its stored theme differs from the markup's default
 *       — which is the case for every site whose theme is its own setting
 *       rather than the device's.
 * </ol>
 *
 * <p>Sampling is not what a browser does, but it is what the platform does:
 * Android picks the gesture handle's own contrast by looking at what is under
 * it. This is the same thing for the bar the app is left to decide.
 *
 * <p>Nothing here reaches into the site. No script is injected, no document is
 * read, nothing is asked of the page — the pixels are the app's own window,
 * already composited, and a site that draws a picture of a status bar is no
 * more able to mislead this than it is to mislead the user's eye.
 */
final class NsiteBarAppearance {

    private static final String TAG = "NsiteBars";

    /**
     * The relative luminance at which black icons start to read better.
     *
     * The WCAG contrast of black against a background of luminance L is
     * {@code (L + 0.05) / 0.05}, and of white {@code 1.05 / (L + 0.05)}. They
     * cross where {@code (L + 0.05)² = 0.0525}, which is here. Stating it as a
     * threshold rather than comparing two ratios means a sample can be reduced
     * to one number — its median luminance — before anything is decided.
     */
    private static final double DARK_ICON_LUMINANCE = Math.sqrt(0.0525) - 0.05;

    /** A strip is scaled into this on the way out; PixelCopy does the scaling. */
    private static final int SAMPLE_WIDTH = 16;
    private static final int SAMPLE_HEIGHT = 4;

    /**
     * No more than one sample per bar in this window, however often it draws.
     *
     * Short enough that a site handing over from its own splash screen is
     * caught within about half a second, long enough that scrolling one costs
     * a few scaled readbacks a second and nothing else.
     */
    private static final long MIN_SAMPLE_INTERVAL_MS = 300;

    /**
     * How long after the site is asked for to take the first sample.
     *
     * The frame fades up over 600ms with React's tuning static behind it, and
     * a sample taken during that reads a blend of the two.
     */
    private static final long FIRST_SAMPLE_DELAY_MS = 750;

    /** A second look, for a site that paints its real colours late. */
    private static final long SETTLING_SAMPLE_DELAY_MS = 1800;

    private final Activity activity;
    private final ViewGroup frame;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final boolean debug;

    private final Bar status = new Bar("status");
    private final Bar navigation = new Bar("navigation");

    @NonNull private Insets safeArea = Insets.NONE;

    /** Set while the site is on screen and its pixels are worth reading. */
    private boolean watching;

    private long lastSampleAt;
    private boolean sampleScheduled;

    /**
     * The earliest a sample may be taken.
     *
     * The frame fades up over React's tuning static, and a strip read during
     * that is a blend of the two — mid-grey noise, which reads as light enough
     * for black icons and then isn't. Both the timed first look and the ones
     * the frame's own drawing asks for have to wait for the same moment, and
     * the drawing starts the instant the fade does.
     */
    private long sampleFrom;

    @Nullable private ViewTreeObserver.OnDrawListener drawListener;

    NsiteBarAppearance(@NonNull Activity activity, @NonNull ViewGroup frame) {
        this.activity = activity;
        this.frame = frame;
        this.debug = (activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    // -----------------------------------------------------------------------
    // What the site said
    // -----------------------------------------------------------------------

    /**
     * Take the colour the document declared, or nothing if it declared none.
     *
     * Applied at once and without hysteresis: it is the opening answer, not a
     * correction to one, and there are no pixels yet to disagree with it. A
     * site that declared nothing gets Tenna's own bars, which is right for what
     * it is shown against — the letterbox it is given is black.
     */
    void declared(@Nullable Integer themeColor) {
        double luminance = themeColor == null
            ? 0
            : ColorUtils.calculateLuminance(ColorUtils.compositeColors(themeColor, Color.BLACK));

        boolean darkIcons = themeColor != null && luminance >= DARK_ICON_LUMINANCE;
        if (debug) {
            Log.d(TAG, "declared " + (themeColor == null ? "nothing" : String.format("#%08x", themeColor))
                + " luminance=" + String.format("%.3f", luminance) + " darkIcons=" + darkIcons);
        }

        status.reset(darkIcons);
        navigation.reset(darkIcons);
        apply();
    }

    /** Where the bars are, so the strips under them can be found. */
    void setSafeArea(@NonNull Insets insets) {
        safeArea = insets;
        if (watching) scheduleSample(0);
    }

    // -----------------------------------------------------------------------
    // What the site painted
    // -----------------------------------------------------------------------

    /**
     * Start reading the site's pixels, once it has some.
     *
     * Called when the document has finished loading. Every later sample is
     * driven by the frame actually drawing, so scrolling, a navigation inside
     * the site and the site's own theme switch are all one hook, and a site
     * sitting still costs nothing.
     */
    void watch() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || watching) return;
        watching = true;
        sampleFrom = System.currentTimeMillis() + FIRST_SAMPLE_DELAY_MS;

        // Posted rather than scheduled, so that neither can be swallowed by
        // the throttle the drawing below goes through.
        handler.postDelayed(this::sample, FIRST_SAMPLE_DELAY_MS);
        handler.postDelayed(this::sample, SETTLING_SAMPLE_DELAY_MS);

        ViewTreeObserver observer = frame.getViewTreeObserver();
        if (!observer.isAlive()) return;

        drawListener = () -> {
            if (!watching) return;
            long since = System.currentTimeMillis() - lastSampleAt;
            scheduleSample(Math.max(0, MIN_SAMPLE_INTERVAL_MS - since));
        };
        observer.addOnDrawListener(drawListener);
    }

    /**
     * Stop reading, and give the bars back to Tenna.
     *
     * For a permission prompt, which is React's and dark and drawn underneath
     * the site, and for the shutoff, which plays over the channel wall. What is
     * on screen owns the bars, and in both cases that is no longer the site.
     */
    void suspend() {
        watching = false;
        handler.removeCallbacksAndMessages(null);
        sampleScheduled = false;
        restore();
    }

    /** The site is back in front; its own colours decide again. */
    void resume() {
        apply();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawListener != null) {
            watching = true;
            scheduleSample(0);
        }
    }

    /** Detach for good, leaving Tenna's own bars behind. */
    void release() {
        watching = false;
        handler.removeCallbacksAndMessages(null);
        sampleScheduled = false;

        if (drawListener != null) {
            ViewTreeObserver observer = frame.getViewTreeObserver();
            if (observer.isAlive()) observer.removeOnDrawListener(drawListener);
            drawListener = null;
        }

        restore();
    }

    // -----------------------------------------------------------------------

    /**
     * Ask for a sample, at most one at a time.
     *
     * A frame that is drawing is drawing sixty times a second, and every one
     * of those asks. One in flight is enough — the next draw after it lands
     * asks again, so a site that keeps moving keeps being read, at the rate
     * set here rather than at the rate it paints.
     */
    private void scheduleSample(long delayMs) {
        if (sampleScheduled) return;
        sampleScheduled = true;
        handler.postDelayed(() -> {
            sampleScheduled = false;
            sample();
        }, delayMs);
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private void sample() {
        if (!watching) return;

        long now = System.currentTimeMillis();
        if (now < sampleFrom) {
            scheduleSample(sampleFrom - now);
            return;
        }

        Window window = activity.getWindow();
        View decor = window == null ? null : window.getDecorView();
        if (decor == null || decor.getWidth() <= 0 || decor.getHeight() <= 0) return;

        lastSampleAt = System.currentTimeMillis();

        int width = decor.getWidth();
        int height = decor.getHeight();

        // A bar with no inset covers nothing, so there is nothing behind it to
        // read — a phone with gesture navigation and no cutout in landscape,
        // for instance.
        if (safeArea.top > 0) {
            request(window, new Rect(0, 0, width, Math.min(safeArea.top, height)), status);
        }
        if (safeArea.bottom > 0) {
            request(window, new Rect(0, Math.max(0, height - safeArea.bottom), width, height), navigation);
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private void request(@NonNull Window window, @NonNull Rect strip, @NonNull Bar bar) {
        if (strip.width() <= 0 || strip.height() <= 0) return;

        Bitmap out = Bitmap.createBitmap(SAMPLE_WIDTH, SAMPLE_HEIGHT, Bitmap.Config.ARGB_8888);
        try {
            PixelCopy.request(window, strip, out, result -> {
                if (result == PixelCopy.SUCCESS && watching) {
                    accept(bar, medianLuminance(out));
                }
                out.recycle();
            }, handler);
        } catch (IllegalArgumentException e) {
            // A strip outside the window's surface, which a rotation can leave
            // behind for a frame. The last answer stands.
            out.recycle();
        }
    }

    /**
     * The median luminance of a sampled strip.
     *
     * Median rather than mean because the strip is mostly the site's own
     * background with something drawn on it — a header, a logo, the site's own
     * title — and an average lets whatever that is drag the answer. Half the
     * strip has to change before the median does.
     */
    private static double medianLuminance(@NonNull Bitmap bitmap) {
        int count = bitmap.getWidth() * bitmap.getHeight();
        int[] pixels = new int[count];
        bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());

        double[] luminances = new double[count];
        for (int i = 0; i < count; i++) {
            luminances[i] = ColorUtils.calculateLuminance(pixels[i] | 0xFF000000);
        }
        java.util.Arrays.sort(luminances);

        return count % 2 == 1
            ? luminances[count / 2]
            : (luminances[count / 2 - 1] + luminances[count / 2]) / 2;
    }

    private void accept(@NonNull Bar bar, double luminance) {
        boolean darkIcons = luminance >= DARK_ICON_LUMINANCE;
        boolean changed = bar.offer(darkIcons);

        // Only when the answer moves. A site being scrolled samples several
        // times a second, and a log line each would bury everything else.
        if (debug && changed) {
            Log.d(TAG, "sampled " + bar.name + " luminance="
                + String.format("%.3f", luminance) + " darkIcons=" + darkIcons);
        }
        if (changed) apply();
    }

    // -----------------------------------------------------------------------

    private void apply() {
        WindowInsetsControllerCompat bars = controller();
        if (bars == null) return;

        bars.setAppearanceLightStatusBars(status.applied);
        bars.setAppearanceLightNavigationBars(navigation.applied);
    }

    /** Tenna's own bars: white icons, for an app that is dark at every screen. */
    private void restore() {
        WindowInsetsControllerCompat bars = controller();
        if (bars == null) return;

        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
    }

    @Nullable
    private WindowInsetsControllerCompat controller() {
        Window window = activity.getWindow();
        if (window == null) return null;
        return WindowCompat.getInsetsController(window, window.getDecorView());
    }

    /**
     * One bar's answer, and what it would take to change it.
     *
     * A sample that disagrees has to say so twice before it is believed, so
     * that a gradient scrolling past, or a picture crossing under the clock,
     * cannot make the icons flicker between black and white. The first sample
     * after a site loads is exempt: there is a wrong answer on screen until it
     * lands, and waiting another 400ms to correct a declaration nobody kept is
     * the one case where hesitating is worse than acting.
     */
    private static final class Bar {
        final String name;
        boolean applied;
        boolean sampled;
        @Nullable Boolean candidate;

        Bar(String name) {
            this.name = name;
        }

        /** Take what the document declared, and forget anything sampled. */
        void reset(boolean darkIcons) {
            applied = darkIcons;
            sampled = false;
            candidate = null;
        }

        /** Returns true when this answer becomes the one to draw. */
        boolean offer(boolean darkIcons) {
            if (!sampled) {
                sampled = true;
                candidate = null;
                boolean changed = applied != darkIcons;
                applied = darkIcons;
                return changed;
            }

            if (darkIcons == applied) {
                candidate = null;
                return false;
            }

            if (candidate != null && candidate == darkIcons) {
                applied = darkIcons;
                candidate = null;
                return true;
            }

            candidate = darkIcons;
            return false;
        }
    }
}
