package pub.soapbox.tenna;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Renders an nsite in a WebView of its own, layered over the Capacitor one.
 *
 * The point of the exercise is frame nesting. Safe-area insets belong to the
 * outermost main frame and to nothing else — not to a cross-origin iframe, not
 * to a same-origin one, not to an iframe in the Fullscreen API — and no API
 * exists to define an environment variable from inside a document. A site in
 * an iframe therefore has to be handed its insets by rewriting the CSS it is
 * served. A site that owns its WebView just asks the platform, and
 * {@code viewport-fit=cover} and {@code env(safe-area-inset-*)} mean what they
 * say.
 *
 * Everything else here follows from that one decision:
 *
 * <ul>
 *   <li>Files are served by {@link NsiteFileServer} on the WebView's own
 *       background thread, so no file bytes cross the Capacitor bridge. The
 *       bridge carries the manifest once and the signer calls, nothing more.
 *   <li>Each site gets its own origin under {@code *.nsite.localhost}, which
 *       separates localStorage and IndexedDB per site and keeps the document
 *       in a secure context. The site's service worker is served from the same
 *       manifest, but by {@link NsiteServiceWorkers} rather than from here.
 *   <li>The view sits above the Capacitor WebView so that touch, focus and the
 *       soft keyboard all behave normally. That buries anything React draws
 *       over the site, so a permission prompt is shown by concealing this
 *       view, and the transitions are run here to match.
 *   <li>A site that doesn't declare {@code viewport-fit=cover} is inset by the
 *       safe area rather than laid out under the system bars, so that the
 *       viewport it is written against is the one it gets. That is what
 *       {@code viewport-fit=auto} asks for and what Chrome only honours for
 *       display cutouts.
 * </ul>
 */
@CapacitorPlugin(name = "NsiteWebView")
public class NsiteWebViewPlugin extends Plugin {

    private static final String TAG = "NsiteWebView";

    /** Injected object name the NIP-07 provider posts through. */
    private static final String HOST_OBJECT = "tennaHost";

    @Nullable private ViewGroup container;
    @Nullable private WebView webView;
    @Nullable private NsiteFileServer fileServer;
    @Nullable private JavaScriptReplyProxy replyProxy;
    @Nullable private String host;

    /**
     * What the site is called, for anything shown in its name.
     *
     * The origin cannot stand in for it. It is a hash under
     * {@code nsite.localhost}, which tells a reader nothing about whose window
     * they are in — so a dialog the site opens is titled with this instead.
     */
    @Nullable private String siteName;

    /**
     * Everything the site's window needs that isn't its own bytes: the file
     * chooser, and whatever else {@link NsiteChromeClient} comes to answer.
     */
    @Nullable private NsiteChromeClient chromeClient;

    /** How an activity started for the site reaches the system. See {@link #load}. */
    @Nullable private ActivityResultLauncher<Intent> activityLauncher;

    /** Who is waiting on the activity that launcher started. */
    @Nullable private NsiteChromeClient.ResultHandler activityResult;

    /**
     * Where the system bars and the cutout are, in pixels.
     *
     * Kept because the letterbox that depends on it outlives any one inset
     * dispatch, and because the site's document may arrive before or after
     * the first one.
     */
    @NonNull private Insets safeArea = Insets.NONE;

    /**
     * Whether the site said it would draw under the system bars itself.
     *
     * Assumed true until its document has been read, because that is the case
     * in which nothing has to happen: the WebView is already full-bleed, so a
     * site that turns out to want it never moves.
     */
    private boolean edgeToEdge = true;

    /**
     * Who draws the clock and the gesture pill while this site is up.
     *
     * Made with the frame and released with it, because what the bars should
     * look like is a question about the pixels in it.
     */
    @Nullable private NsiteBarAppearance barAppearance;

    /**
     * Whether the shutoff animation is already playing.
     *
     * The frame is asked to close twice — once when the viewer starts its own
     * shutoff, and again when the component finally unmounts — and the second
     * ask arrives while the first animation is still running. Without this it
     * would start a second animation over the first and destroy the WebView
     * from two end actions, tearing a live surface out from under the render
     * thread.
     */
    private boolean shuttingDown;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Register the launcher a site's file chooser starts activities through.
     *
     * Here, and not where it is used, because
     * {@code registerForActivityResult} throws once the activity it is
     * registered against has been started — and a site is opened long after
     * that. {@code load} is the last moment before it: Capacitor builds the
     * bridge, and loads every plugin on it, from inside
     * {@code BridgeActivity.onCreate}.
     *
     * One launcher serves every site the window ever shows. There is only ever
     * one site up at a time, and the handler for the result travels with the
     * intent rather than being fixed here.
     */
    @Override
    public void load() {
        activityLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                NsiteChromeClient.ResultHandler handler = activityResult;
                activityResult = null;
                if (handler != null) handler.handle(result.getResultCode(), result.getData());
            }
        );
    }

    /**
     * Start an activity on the site's behalf, reporting whether anything took
     * it.
     *
     * An implicit intent with nothing to answer it throws rather than
     * returning, and asking {@code resolveActivity} first would only move the
     * question to package visibility — this app is shown a deliberately narrow
     * slice of the device (see the manifest's {@code <queries>}). Catching is
     * both simpler and true whatever the reason.
     */
    private boolean startForResult(
        @NonNull Intent intent,
        @NonNull NsiteChromeClient.ResultHandler handler
    ) {
        ActivityResultLauncher<Intent> launcher = activityLauncher;
        if (launcher == null) return false;

        activityResult = handler;
        try {
            launcher.launch(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            activityResult = null;
            return false;
        }
    }

    @PluginMethod
    @SuppressLint("SetJavaScriptEnabled")
    public void open(PluginCall call) {
        String siteId = call.getString("siteId");
        String name = call.getString("name");
        String providerScript = call.getString("providerScript");
        JSObject manifest = call.getObject("files");
        JSArray serverList = call.getArray("servers");
        JSObject share = call.getObject("share");

        if (siteId == null || manifest == null || serverList == null) {
            call.reject("siteId, files and servers are required");
            return;
        }

        final Map<String, String> files = new HashMap<>();
        for (Iterator<String> keys = manifest.keys(); keys.hasNext(); ) {
            String path = keys.next();
            String sha256 = manifest.optString(path, null);
            if (sha256 != null) files.put(path, sha256);
        }

        final List<String> servers = new ArrayList<>();
        try {
            for (Object server : serverList.toList()) {
                if (server instanceof String) servers.add((String) server);
            }
        } catch (JSONException e) {
            call.reject("Malformed servers list", e);
            return;
        }

        final String siteHost = NsiteOrigins.hostFor(siteId);
        final String origin = NsiteOrigins.originFor(siteId);
        final String landing = landingPath(getContext(), siteId, share);

        getActivity().runOnUiThread(() -> {
            destroyWebView();

            host = siteHost;
            siteName = name;
            edgeToEdge = true;
            fileServer = new NsiteFileServer(
                files,
                servers,
                NsiteFileServer.cacheDir(getContext()),
                // Raised on the WebView's background thread.
                siteChrome -> getActivity().runOnUiThread(() -> applySiteChrome(siteChrome))
            );
            // Registered so that the site's service worker — whose fetches
            // reach the process-wide client rather than this view's — is
            // served from this manifest rather than from the one on disk.
            NsiteFileServers.register(siteHost, fileServer);

            WebView view = new WebView(getContext());
            configure(view);
            installBridge(view, origin, providerScript);

            // The frame the site's pixels travel in: it fades in with them,
            // shuts off with them, and hides them behind a permission prompt.
            // It also paints the letterbox for a site that isn't drawing under
            // the system bars itself.
            FrameLayout frame = new FrameLayout(getContext());
            frame.setBackgroundColor(Color.BLACK);

            // Start invisible: React is painting tuning static underneath, and
            // the site fades up over it once it has something to show.
            frame.setAlpha(0f);

            frame.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ));

            ViewGroup content = getActivity().findViewById(android.R.id.content);
            content.addView(frame, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ));

            container = frame;
            webView = view;
            barAppearance = new NsiteBarAppearance(getActivity(), frame);

            observeInsets(frame);

            view.loadUrl(origin + landing);
            call.resolve();
        });
    }

    /**
     * Point an open site at a share, leaving its WebView where it is.
     *
     * Reopening would work and is what a cleared task ends up doing anyway, but
     * a share into an app that is already up should read as that app receiving
     * something — not as it restarting.
     */
    @PluginMethod
    public void navigate(PluginCall call) {
        String siteId = call.getString("siteId");
        JSObject share = call.getObject("share");

        if (siteId == null || share == null) {
            call.reject("siteId and share are required");
            return;
        }

        final String expected = NsiteOrigins.hostFor(siteId);
        final String url = NsiteOrigins.originFor(siteId)
            + landingPath(getContext(), siteId, share);

        getActivity().runOnUiThread(() -> {
            if (webView == null || host == null || !host.equalsIgnoreCase(expected)) {
                call.reject("That site has no window here");
                return;
            }
            webView.loadUrl(url);
            call.resolve();
        });
    }

    /**
     * The path a site opens on: its front page, or the share it was opened for.
     *
     * A {@code GET} target is navigated to directly — the site's own action
     * with the params in its query, exactly the request a browser would make,
     * with no page of Tenna's in between. A {@code POST} one cannot be: only a
     * document at the site's origin can submit a multipart form, so the share
     * is claimed for this site and the bootstrap page is loaded to make the
     * navigation. See {@link NsiteRequests}.
     *
     * The plan itself is never read here. It was built and checked in the web
     * layer, out of the site's own manifest, and travels as opaque JSON.
     */
    private static String landingPath(
        @NonNull Context context,
        @NonNull String siteId,
        @Nullable JSObject share
    ) {
        if (share == null) return "/";

        String kind = share.getString("kind");

        if ("get".equals(kind)) {
            String path = share.getString("path");
            // Site-absolute or nothing: a path is built from the site's own
            // action, but it arrives over a bridge and a leading `//` would be
            // a protocol-relative URL onto somebody else's host.
            if (path != null && path.startsWith("/") && !path.startsWith("//")) return path;
            return "/";
        }

        if ("post".equals(kind)) {
            String token = share.getString("token");
            String plan = share.getString("plan");
            if (token == null || plan == null) return "/";

            NsiteShares.claim(context, token, siteId, plan);
            return NsiteRequests.SHARE_PATH + "?" + NsiteRequests.TOKEN_PARAM + "=" + token;
        }

        return "/";
    }

    /**
     * Track the safe area for as long as the site is open.
     *
     * The insets are returned untouched so that the Capacitor WebView beside
     * us still receives them — Tenna's own chrome is laid out from the same
     * numbers. Listening rather than reading once is what makes a rotation
     * move the letterbox with the cutout.
     */
    private void observeInsets(View view) {
        ViewCompat.setOnApplyWindowInsetsListener(view, (v, insets) -> {
            safeArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            layoutForSafeArea();
            // The strips read for the bars' own contrast are the strips the
            // bars cover, so a rotation moves them with the cutout.
            if (barAppearance != null) barAppearance.setSafeArea(safeArea);
            return insets;
        });
        ViewCompat.requestApplyInsets(view);
    }

    /** Lay the site out for the current insets. */
    private void layoutForSafeArea() {
        WebView view = webView;
        if (view != null) {
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) view.getLayoutParams();
            // A site that opted in fills the window and pads itself with
            // `env()`. One that didn't is inset until its viewport really is
            // the safe area, which is the assumption its CSS is written under.
            params.setMargins(
                edgeToEdge ? 0 : safeArea.left,
                edgeToEdge ? 0 : safeArea.top,
                edgeToEdge ? 0 : safeArea.right,
                edgeToEdge ? 0 : safeArea.bottom
            );
            view.setLayoutParams(params);
        }
    }

    /** Take what the site's document asked for, once it has been read. */
    private void applySiteChrome(NsiteSiteChrome siteChrome) {
        edgeToEdge = siteChrome.edgeToEdge;
        Integer themeColor = siteChrome.themeColor(prefersDark());

        ViewGroup frame = container;
        if (frame != null && !siteChrome.edgeToEdge && themeColor != null) {
            // The strips left by the letterbox read as part of the site rather
            // than as a black border around it.
            frame.setBackgroundColor(themeColor);
        }

        // The opening answer for the system bars, until the site has painted
        // something to read instead. See NsiteBarAppearance.
        if (barAppearance != null) barAppearance.declared(themeColor);

        layoutForSafeArea();
    }

    /**
     * Which colour scheme the site is being shown in.
     *
     * Not the device's night setting: for an app targeting Android 13 or later
     * the WebView reports {@code prefers-color-scheme} from the theme of the
     * activity hosting it, which comes down to {@code android:isLightTheme}.
     * Reading the same attribute resolves the site's media queries the same way
     * the site's own stylesheets resolved them, which is the point — a site
     * must not be told one thing and have Tenna act on the other.
     */
    private boolean prefersDark() {
        TypedValue value = new TypedValue();
        if (getActivity().getTheme().resolveAttribute(android.R.attr.isLightTheme, value, true)
            && value.type == TypedValue.TYPE_INT_BOOLEAN) {
            return value.data == 0;
        }

        // A theme that says nothing leaves the device's own setting, which is
        // what a WebView too old for the above follows anyway.
        int night = getContext().getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ViewGroup view = container;
            if (view == null || shuttingDown) {
                call.resolve();
                return;
            }
            shuttingDown = true;

            // The picture is leaving, and what it collapses onto is Tenna's.
            // Waiting for the view to be destroyed would leave the site's bars
            // over half a second of somebody else's screen — and the shutoff
            // is half a second of pixels that are no longer the site's.
            if (barAppearance != null) barAppearance.suspend();

            // Approximates the `crt-off` keyframes the React layer uses: the
            // picture collapses to a line, then to a point, then goes out.
            view.animate()
                .scaleY(0.004f)
                .setDuration(300)
                .withEndAction(() -> view.animate()
                    .scaleX(0.002f)
                    .alpha(0f)
                    .setDuration(250)
                    .setListener(new AnimatorListenerAdapter() {
                        @Override
                        public void onAnimationEnd(Animator animation) {
                            destroyWebView();
                        }
                    })
                    .start())
                .start();

            call.resolve();
        });
    }

    /**
     * Step back through the site's own history, reporting whether it could.
     *
     * A back gesture belongs to the site while the site has somewhere to go;
     * only then does it mean "leave". The iframe implementation can't offer
     * this — the history of a cross-origin frame isn't readable — so back
     * closes the viewer outright there.
     */
    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();

            WebView view = webView;
            boolean moved = view != null && view.canGoBack();
            if (moved) view.goBack();
            result.put("moved", moved);
            call.resolve(result);
        });
    }

    /**
     * Hide the site without unloading it, for permission prompts.
     *
     * The prompt is drawn by React, underneath this view, so the site has to
     * get out of the way — which also means it cannot paint anything behind a
     * security decision the user is being asked to make.
     */
    @PluginMethod
    public void setConcealed(PluginCall call) {
        boolean concealed = Boolean.TRUE.equals(call.getBoolean("concealed", false));
        getActivity().runOnUiThread(() -> {
            if (container != null) {
                container.setVisibility(concealed ? View.INVISIBLE : View.VISIBLE);
            }
            // The bars belong to whatever is on screen. While the prompt is up
            // that is React's, which is dark; afterwards it is the site again.
            if (barAppearance != null) {
                if (concealed) barAppearance.suspend();
                else barAppearance.resume();
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(this::destroyWebView);
    }

    private void destroyWebView() {
        // First, before anything else is taken apart: a window closed with a
        // picker still up leaves Chromium blocked on a chooser nobody will
        // ever answer. See NsiteChromeClient.
        NsiteChromeClient chrome = chromeClient;
        chromeClient = null;
        if (chrome != null) chrome.release();

        WebView view = webView;
        ViewGroup frame = container;
        NsiteFileServer server = fileServer;
        String served = host;
        NsiteBarAppearance bars = barAppearance;
        webView = null;
        container = null;
        fileServer = null;
        replyProxy = null;
        host = null;
        siteName = null;
        barAppearance = null;
        shuttingDown = false;

        // Nothing of the site's outlives it, the bars included. `close` has
        // usually given them back already; the paths that skip the shutoff
        // have not, and the draw listener has to come off the view either way.
        if (bars != null) bars.release();

        if (server != null && served != null) NsiteFileServers.unregister(served, server);

        if (frame != null) {
            // Whoever got here first wins: opening another site, or the
            // activity going away, can arrive mid-shutoff. Stop the animation
            // before the view it is transforming is taken apart.
            frame.animate().setListener(null).cancel();
            ViewCompat.setOnApplyWindowInsetsListener(frame, null);
            ViewGroup parent = (ViewGroup) frame.getParent();
            if (parent != null) parent.removeView(frame);
            frame.removeAllViews();
        }
        if (view != null) view.destroy();
    }

    // -----------------------------------------------------------------------
    // WebView setup
    // -----------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);

        // Without this the viewport meta is ignored, which would take
        // `viewport-fit=cover` — the whole point — with it.
        settings.setUseWideViewPort(true);

        // Nothing an nsite is served comes from the device's own files.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        // The window is edge to edge; let the site fill it, and report the
        // insets rather than eating them.
        view.setFitsSystemWindows(false);

        // Read off the manifest rather than BuildConfig, which this module
        // doesn't generate.
        boolean debuggable =
            (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Without one of these the WebView doesn't fall back to anything for a
        // file chooser — it drops the request on the floor, which is a site
        // whose upload button does nothing when it is pressed.
        NsiteChromeClient chrome = new NsiteChromeClient(
            getActivity(), siteName, this::startForResult);
        chromeClient = chrome;
        view.setWebChromeClient(chrome);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                // Everything the document itself asks for. Its worker's
                // requests do not come through here — see NsiteServiceWorkers
                // — but both end up in the same router.
                return NsiteRequests.serve(getContext(), request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                String expected = host;
                // Inside its own origin the site navigates as it pleases.
                if (expected != null && expected.equalsIgnoreCase(url.getHost())) return false;

                // Anything else is a link out, which this window cannot
                // follow: it is one site's window, not a browser, and there is
                // nowhere in it for another origin to go. So it is handed to
                // the device, which is where a link out of an app goes.
                //
                // Only the main frame's. A third-party subframe reaching for
                // its own origin is the page loading itself, not somebody
                // asking to leave, and an embedded video has no business
                // throwing the user into a browser.
                if (request.isForMainFrame()) handOff(request);
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                Log.w(TAG, "Site failed to load " + request.getUrl() + ": " + error.getErrorCode() + " " + error.getDescription());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                notifyListeners("nsiteLoad", new JSObject());
                // The frame, not the WebView: the letterbox comes up with the
                // picture, not before it.
                ViewGroup frame = container;
                if (frame != null) frame.animate().alpha(1f).setDuration(600).start();
                // There are pixels now, so what the site said about its colour
                // stops being the only thing to go on.
                if (barAppearance != null) barAppearance.watch();
            }
        });
    }

    /**
     * Hand a link out of the site to whatever on the device answers for it.
     *
     * A site's window has no address bar and no second tab, so a link to
     * anywhere else can only be somebody else's to open: an http link goes to
     * the browser, a {@code mailto:} to the mail app, a {@code lightning:} to a
     * wallet. That is the same thing the tile for a native app does, and it
     * runs through the same helper.
     *
     * Two things are asked of the link first. It must be one the user pressed,
     * because a page that reaches for another app on load is not following
     * anybody, and a site that could do that could throw somebody out of the
     * app it took them a tap to enter, over and over. A redirect passes on the
     * gesture that began it, so it counts as the tail of a press.
     *
     * And its scheme must not be one of {@link #UNHANDLED_SCHEMES}.
     */
    private void handOff(@NonNull WebResourceRequest request) {
        Uri url = request.getUrl();
        String scheme = url.getScheme();

        if (scheme == null || UNHANDLED_SCHEMES.contains(scheme.toLowerCase(Locale.ROOT))) {
            Log.i(TAG, "Refused to hand the device a " + scheme + ": link");
            return;
        }

        if (!request.hasGesture() && !request.isRedirect()) {
            Log.i(TAG, "Refused an unasked-for navigation to " + url);
            return;
        }

        if (!NativeApps.openUri(getContext(), url.toString())) {
            Log.i(TAG, "Nothing on the device answers for " + url);
        }
    }

    /**
     * Schemes a site never gets to hand the device.
     *
     * {@code intent:} and {@code android-app:} are not links. They are Intents
     * written out as text, and an Intent the page composes can name an explicit
     * component of another app and the extras to call it with — reaching past
     * anything a link is allowed to do, from a document Tenna did not write.
     * {@code file:} and {@code content:} name the device's own storage, which
     * is not the site's to point a viewer at. The rest never reach a URL
     * handler anyway, and are refused here so that stays true.
     */
    private static final Set<String> UNHANDLED_SCHEMES = new HashSet<>(Arrays.asList(
        "intent", "android-app", "file", "content", "javascript", "data", "about"
    ));

    /**
     * Install the NIP-07 provider and its transport.
     *
     * {@code addDocumentStartJavaScript} runs the script before any of the
     * page's own, which is what {@code window.nostr} has to promise: a site
     * that checks for a provider at module scope has to find one. Both APIs
     * are scoped to the site's origin, so no other document can reach them.
     */
    private void installBridge(WebView view, String origin, @Nullable String providerScript) {
        Set<String> allowed = Collections.singleton(origin);

        if (providerScript == null) return;

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Without both, the provider would either arrive too late to be
            // found or have no way to call home. Better no `window.nostr` than
            // one that hangs.
            return;
        }

        WebViewCompat.addWebMessageListener(view, HOST_OBJECT, allowed, (v, message, sourceOrigin, isMainFrame, proxy) -> {
            if (!isMainFrame) return;
            replyProxy = proxy;
            forwardRpc(message);
        });

        WebViewCompat.addDocumentStartJavaScript(view, providerScript, allowed);
    }

    private void forwardRpc(@NonNull WebMessageCompat message) {
        String data = message.getData();
        if (data == null) return;

        try {
            JSONObject request = new JSONObject(data);
            JSObject event = new JSObject();
            event.put("id", request.optInt("id", -1));
            event.put("method", request.optString("method"));
            // Params travel as JSON text. A signed event's tags are an
            // arbitrarily shaped array, and round-tripping that through
            // Capacitor's object coercion loses types.
            event.put("params", request.opt("params") == null ? "{}" : request.get("params").toString());
            notifyListeners("nsiteRpc", event);
        } catch (JSONException ignored) {
            // A malformed message is the site's problem; it gets no reply.
        }
    }

    /** Deliver a JSON-RPC response for a call previously raised as `nsiteRpc`. */
    @PluginMethod
    public void respond(PluginCall call) {
        Integer id = call.getInt("id");
        String result = call.getString("result");
        String error = call.getString("error");

        JavaScriptReplyProxy proxy = replyProxy;
        if (id == null || proxy == null) {
            call.resolve();
            return;
        }

        try {
            JSONObject response = new JSONObject();
            response.put("jsonrpc", "2.0");
            response.put("id", id);
            if (error != null) {
                JSONObject detail = new JSONObject();
                detail.put("code", -1);
                detail.put("message", error);
                response.put("error", detail);
            } else {
                response.put("result", result == null ? JSONObject.NULL : new org.json.JSONTokener(result).nextValue());
            }
            final String payload = response.toString();
            getActivity().runOnUiThread(() -> proxy.postMessage(payload));
        } catch (JSONException e) {
            call.reject("Malformed response", e);
            return;
        }

        call.resolve();
    }
}
