package pub.soapbox.tenna;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.util.Locale;

/**
 * Somewhere else on the web, opened over the site that linked to it.
 *
 * A site's window is not a browser, so a link out of it used to go to the
 * device's. That is right for a link somebody follows to read something, and
 * wrong for every flow that expects to come back: a checkout, a sign-in, a
 * payment page. Those send the user on to an address the site gave them —
 * almost always its own origin — and a site's origin here is
 * {@code *.nsite.localhost}, which exists only inside this app's WebViews. A
 * browser asked for it reaches loopback and is refused, which is where a paid
 * Stripe checkout used to leave people.
 *
 * So a link out opens here instead, on top of the site and in its task, and
 * the moment anything here heads for the site's origin this window closes and
 * hands the address back for the site's own window to load. That is what a
 * browser's popup does with the same flow, minus the second tab.
 *
 * <p>Nothing of the site's is in this window. It has no bridge, no provider and
 * no file server, and it never shows the site's origin at all — a navigation
 * there is the end of it. What it shares with the site is the site's profile,
 * so a cookie a provider set inside the site's iframe is the one it sees here,
 * as it would be in one browser.
 *
 * <p>Always the host in the toolbar, because this window draws a page from
 * anywhere over a site the user trusts, and the title is the page's to choose.
 */
public class NsiteBrowserActivity extends AppCompatActivity {

    private static final String TAG = "NsiteBrowser";

    /** Where to go: an http or https URL. */
    private static final String EXTRA_URL = "pub.soapbox.tenna.BROWSER_URL";

    /** The site that opened this window, for its profile. */
    private static final String EXTRA_SITE_ID = "pub.soapbox.tenna.BROWSER_SITE_ID";

    @Nullable private WebView webView;
    @Nullable private Toolbar toolbar;
    @Nullable private ProgressBar progress;

    /** Whether this window has already handed something back. */
    private boolean returned;

    /** The intent that opens {@code url} over the site {@code siteId}. */
    @NonNull
    static Intent intentFor(@NonNull Context context, @NonNull String url, @NonNull String siteId) {
        return new Intent(context, NsiteBrowserActivity.class)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_SITE_ID, siteId);
    }

    /** Whether this window is somewhere a link to {@code url} can open. */
    static boolean opens(@NonNull Uri url) {
        String scheme = url.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        return "https".equals(scheme) || "http".equals(scheme);
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String siteId = getIntent().getStringExtra(EXTRA_SITE_ID);
        if (url == null || !opens(Uri.parse(url))) {
            finish();
            return;
        }

        int background = ContextCompat.getColor(this, R.color.nsiteWindow);

        // Drawn under the bars, and padded out of them below, so that the bars
        // are this window's colour on every version rather than only on the
        // ones that force edge to edge.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(background);

        Toolbar bar = new Toolbar(this);
        bar.setBackgroundColor(background);
        bar.setTitleTextColor(Color.WHITE);
        bar.setSubtitleTextColor(0xB3FFFFFF);
        bar.setNavigationIcon(R.drawable.ic_browser_close);
        bar.setNavigationContentDescription(R.string.nsite_browser_close);
        bar.setNavigationOnClickListener(v -> finish());
        MenuItem external = bar.getMenu().add(R.string.nsite_browser_open_externally);
        external.setIcon(R.drawable.ic_browser_open_externally);
        external.setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
        external.setOnMenuItemClickListener(item -> {
            openExternally();
            return true;
        });
        root.addView(bar, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        ProgressBar loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setMax(100);
        loading.setProgressTintList(ColorStateList.valueOf(Color.WHITE));
        loading.setProgressBackgroundTintList(ColorStateList.valueOf(background));
        root.addView(loading, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            (int) (2 * getResources().getDisplayMetrics().density)
        ));

        WebView view = new WebView(this);
        // First, before anything uses the view. See NsiteProfiles.
        if (siteId != null && NsiteOrigins.isSiteId(siteId)) NsiteProfiles.attach(view, siteId);
        configure(view);
        root.addView(view, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets system = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(system.left, system.top, system.right, Math.max(system.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        setContentView(root);

        toolbar = bar;
        progress = loading;
        webView = view;

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView current = webView;
                if (current != null && current.canGoBack()) current.goBack();
                else finish();
            }
        });

        showAddress(url, null);
        view.loadUrl(url);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(@NonNull WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Popups stay in this window, the same as the site's.
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int newProgress) {
                ProgressBar bar = progress;
                if (bar == null) return;
                bar.setProgress(newProgress);
                bar.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }

            @Override
            public void onReceivedTitle(WebView v, String title) {
                showAddress(v.getUrl(), title);
            }
        });

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                return route(request.getUrl(), request.hasGesture() || request.isRedirect());
            }

            /**
             * The second look, for what never reached the first.
             *
             * {@code shouldOverrideUrlLoading} is not raised for a POST, and a
             * flow that returns by submitting a form to the site's origin is
             * not unusual. It still starts a page, and a page at the site's
             * origin is the end of this window either way.
             */
            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                Uri uri = Uri.parse(url);
                if (NsiteOrigins.siteIdFor(uri.getHost()) != null) {
                    v.stopLoading();
                    giveBack(uri);
                    return;
                }
                showAddress(url, null);
            }

            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean isReload) {
                showAddress(url, v.getTitle());
            }
        });

        // A file is not a page. The device's browser knows what to do with
        // one, and has a downloads list to put it in.
        view.setDownloadListener((url, userAgent, disposition, mimeType, length) -> {
            if (opens(Uri.parse(url)) && !NativeApps.openUri(this, url)) {
                Log.i(TAG, "Nothing on the device answers for " + url);
            }
        });
    }

    /**
     * Decide where a navigation goes, answering whether this window keeps it.
     *
     * The web goes on in here. A site's origin is the way back, and ends this
     * window. Anything else — a {@code mailto:}, a wallet, an app's own scheme
     * — goes to the device on the same terms a link out of the site itself
     * does: pressed, or the redirect that followed a press, and never one of
     * the schemes that are Intents in disguise.
     */
    private boolean route(@NonNull Uri url, boolean asked) {
        if (NsiteOrigins.siteIdFor(url.getHost()) != null) {
            giveBack(url);
            return true;
        }

        if (opens(url)) return false;

        String scheme = url.getScheme();
        if (scheme == null || NsiteWebViewPlugin.isUnhandledScheme(scheme)) {
            Log.i(TAG, "Refused to hand the device a " + scheme + ": link");
            return true;
        }
        if (!asked) {
            Log.i(TAG, "Refused an unasked-for navigation to " + url);
            return true;
        }
        if (!NativeApps.openUri(this, url.toString())) {
            Log.i(TAG, "Nothing on the device answers for " + url);
        }
        return true;
    }

    /** Close, handing the site's window the address that brought us back. */
    private void giveBack(@NonNull Uri url) {
        if (returned) return;
        returned = true;
        setResult(Activity.RESULT_OK, new Intent().setData(url));
        finish();
    }

    /** Give the page to the device's browser, and get out of the way. */
    private void openExternally() {
        WebView view = webView;
        String url = view == null ? null : view.getUrl();
        if (url == null || !opens(Uri.parse(url))) url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null) return;

        if (NativeApps.openUri(this, url)) finish();
        else Log.i(TAG, "Nothing on the device answers for " + url);
    }

    /** The page's title over its host, or the host alone until it has one. */
    private void showAddress(@Nullable String url, @Nullable String title) {
        Toolbar bar = toolbar;
        if (bar == null || url == null) return;

        String host = Uri.parse(url).getHost();
        if (host == null) host = url;

        if (title == null || title.trim().isEmpty() || title.equals(url)) {
            bar.setTitle(host);
            bar.setSubtitle(null);
        } else {
            bar.setTitle(title);
            bar.setSubtitle(host);
        }
    }

    @Override
    protected void onDestroy() {
        WebView view = webView;
        webView = null;
        if (view != null) {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
        }
        super.onDestroy();
    }
}
