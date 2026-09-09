package pub.soapbox.tenna;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Everything a site's window needs that isn't the site's own bytes.
 *
 * A {@link WebView} routes two quite different sorts of thing through its
 * clients. Its {@code WebViewClient} answers questions about the network —
 * what to serve, where a navigation may go — and {@link NsiteWebViewPlugin}
 * has always set one. Its {@code WebChromeClient} answers questions about the
 * browser <em>around</em> the page: the file chooser, the JavaScript dialogs,
 * fullscreen. A WebView with no chrome client does not fall back to sensible
 * behaviour for those; it silently does nothing at all. That is why a site's
 * upload button did nothing when it was pressed.
 *
 * <p>Capacitor's own {@code BridgeWebChromeClient} is deliberately not reused
 * here. It grants {@code getUserMedia} off the app's manifest permissions
 * without asking anyone, which is not a decision a site gets to have made for
 * it, and it puts its fullscreen view in the bridge activity's content view,
 * which is not the frame a site's pixels live in. What is inherited instead is
 * the default {@link WebChromeClient} behaviour, which denies every permission
 * request — so nothing a site could not already do becomes possible by having
 * this class.
 *
 * <p>The one rule that runs through all of it: Chromium blocks the page on
 * whatever it asked for until it is answered, exactly once. A chooser callback
 * that is dropped rather than resolved doesn't fail the one upload — it takes
 * the site's upload button out for as long as the window is open, because no
 * further chooser will be shown until the outstanding one replies. Hence
 * {@link #answer} and {@link #release}.
 */
final class NsiteChromeClient extends WebChromeClient {

    private static final String TAG = "NsiteChrome";

    /** Where a photo or a video taken for an upload is written. */
    private static final String CAPTURE_DIRECTORY = "nsite-capture";

    /** How long a capture file is kept before it counts as litter. */
    private static final long CAPTURE_LIFETIME_MS = 24 * 60 * 60 * 1000L;

    /**
     * Starts an activity and reports back what it returned.
     *
     * The chooser has to be launched through a registered
     * {@code ActivityResultLauncher}, and registering one is only legal before
     * the activity starts — so the launcher belongs to the plugin, which is
     * loaded early enough to make one, and reaches this class as a callback.
     *
     * @return whether anything on the device took the intent.
     */
    interface Launcher {
        boolean launch(@NonNull Intent intent, @NonNull ResultHandler handler);
    }

    /** What a launched activity returned. */
    interface ResultHandler {
        void handle(int resultCode, @Nullable Intent data);
    }

    private final Activity activity;
    private final Launcher launcher;

    /** The chooser Chromium is blocked on, or null when there is none. */
    @Nullable private ValueCallback<Uri[]> pending;

    NsiteChromeClient(@NonNull Activity activity, @NonNull Launcher launcher) {
        this.activity = activity;
        this.launcher = launcher;
    }

    /**
     * Give up on anything outstanding, because the window is going away.
     *
     * Called when the site's WebView is destroyed. The picker it opened may
     * still be on screen and will still return, to a callback that is by then
     * nobody's; answering now is what keeps that from being a leak.
     */
    void release() {
        answer(null);
    }

    // -----------------------------------------------------------------------
    // File uploads
    // -----------------------------------------------------------------------

    /**
     * Show the site the device's file picker, or its camera.
     *
     * Nothing is granted by doing this. The site is handed the URIs the user
     * chose and no others, and it cannot reach anything it wasn't given — the
     * same bargain a browser makes. A site cannot open this unasked either:
     * Chromium requires a user gesture before {@code input.click()} will
     * summon a chooser at all.
     */
    @Override
    public boolean onShowFileChooser(
        WebView view,
        ValueCallback<Uri[]> callback,
        FileChooserParams params
    ) {
        // Chromium won't ask twice over, but a callback stranded by an earlier
        // failure would keep `pending` pointing at a chooser nobody is waiting
        // on. Answering it costs nothing and keeps the field honest.
        answer(null);
        pending = callback;

        List<String> accept = Arrays.asList(params.getAcceptTypes());

        // `capture` asks for the device's camera rather than its files. It is
        // a request, not a requirement — a device with no camera app falls
        // through to the picker, which is what a browser does with it too.
        if (params.isCaptureEnabled()) {
            if (accept.contains("video/*") && captureVideo()) return true;
            if (accept.contains("image/*") && capturePhoto()) return true;
        }

        pick(params);
        return true;
    }

    /** Show the device's file picker for what the site said it accepts. */
    private void pick(@NonNull FileChooserParams params) {
        Intent intent = params.createIntent();

        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        // `createIntent` copies the first accept entry into the intent's type
        // verbatim, so a site asking for `.pdf` gets a type of ".pdf" — which
        // is not a MIME type and matches nothing on the device.
        String[] types = mimeTypes(params.getAcceptTypes());
        if (types.length == 1) {
            intent.setType(types[0]);
        } else if (types.length > 1) {
            // A picker takes one type and a list of them, and reads the list
            // in preference — but the type is still what decides which apps
            // resolve the intent, so it has to be the wide one.
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        }

        if (!launcher.launch(intent, (code, data) -> answer(picked(code, data)))) {
            Log.w(TAG, "Nothing on the device can pick a file");
            answer(null);
        }
    }

    /**
     * Take a photo for the upload.
     *
     * The camera writes into a file of Tenna's rather than into the device's
     * pictures: a photo taken to be uploaded is not one the user asked to
     * keep, and the cache is somewhere the system can reclaim.
     *
     * Deliberately no {@code CAMERA} permission. Android requires one for
     * {@code ACTION_IMAGE_CAPTURE} only from apps that <em>declare</em> it,
     * and Tenna does not — the camera app takes the photo, and Tenna is only
     * handed the result. Declaring it would gain nothing and cost a runtime
     * prompt.
     */
    private boolean capturePhoto() {
        final Uri output;
        try {
            output = captureFile("jpg");
        } catch (IOException e) {
            Log.w(TAG, "Nowhere to put a captured photo", e);
            return false;
        }

        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
        // The camera app is a different app writing into Tenna's file, so it
        // has to be let in; the read grant is for handing the result back.
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);

        return launcher.launch(intent, (code, data) ->
            answer(code == Activity.RESULT_OK ? new Uri[] { output } : null));
    }

    /**
     * Record a video for the upload.
     *
     * Unlike a photo the camera app chooses where this lands and hands back
     * the URI it used, so there is no output file to name.
     */
    private boolean captureVideo() {
        Intent intent = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);

        return launcher.launch(intent, (code, data) -> {
            Uri taken = data == null ? null : data.getData();
            answer(code == Activity.RESULT_OK && taken != null ? new Uri[] { taken } : null);
        });
    }

    /** A file for the camera to write into, and the URI that reaches it. */
    @NonNull
    private Uri captureFile(@NonNull String extension) throws IOException {
        File directory = new File(activity.getCacheDir(), CAPTURE_DIRECTORY);
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        sweepCaptures(directory);

        File file = File.createTempFile("capture", "." + extension, directory);
        return FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
    }

    /**
     * Drop captures old enough that nothing can still be reading them.
     *
     * There is no moment at which a capture is known to be finished with — the
     * site holds the URI for as long as its form is up — so they are cleared
     * on age instead, the next time the camera is reached for.
     */
    private static void sweepCaptures(@NonNull File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;

        long expiry = System.currentTimeMillis() - CAPTURE_LIFETIME_MS;
        for (File file : files) {
            //noinspection ResultOfMethodCallIgnored
            if (file.lastModified() < expiry) file.delete();
        }
    }

    /** The URIs a picker returned, or null if it returned none. */
    @Nullable
    private static Uri[] picked(int resultCode, @Nullable Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return null;

        // A multi-select comes back as a clip rather than as the intent's
        // data, and `parseResult` reads only the latter.
        ClipData clip = data.getClipData();
        if (clip == null) return FileChooserParams.parseResult(resultCode, data);
        if (clip.getItemCount() == 0) return null;

        Uri[] files = new Uri[clip.getItemCount()];
        for (int i = 0; i < files.length; i++) files[i] = clip.getItemAt(i).getUri();
        return files;
    }

    /**
     * The accept list as MIME types.
     *
     * {@code accept} is written in either of two languages — a MIME type or a
     * file extension — and the device's pickers only speak the first.
     */
    @NonNull
    private static String[] mimeTypes(@Nullable String[] accept) {
        if (accept == null) return new String[0];

        List<String> types = new ArrayList<>(accept.length);
        MimeTypeMap extensions = MimeTypeMap.getSingleton();

        for (String entry : accept) {
            if (entry == null || entry.isEmpty()) continue;

            String type = entry.startsWith(".")
                ? extensions.getMimeTypeFromExtension(entry.substring(1).toLowerCase(Locale.ROOT))
                : entry;

            if (type != null && !types.contains(type)) types.add(type);
        }

        return types.toArray(new String[0]);
    }

    /**
     * Hand Chromium the outcome of a chooser, once.
     *
     * Once, because a second call on the same callback is a crash in the
     * renderer, and never is a site whose uploads have stopped working. Every
     * path out of a chooser — a pick, a cancel, a device with no picker on it,
     * the window closing mid-choice — arrives here.
     */
    private void answer(@Nullable Uri[] files) {
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        if (callback != null) callback.onReceiveValue(files);
    }
}
