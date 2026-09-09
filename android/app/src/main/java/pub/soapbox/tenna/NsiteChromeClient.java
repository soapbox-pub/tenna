package pub.soapbox.tenna;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
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
     * What a capability is called on the way to the web layer.
     *
     * These strings are the `NsiteBrowserPermissionType` union in
     * `nsiteBrowserPermissions.ts`, and are what a stored decision is filed
     * under. They are not Android's names for the same things, which is
     * `Manifest.permission` and is the plugin's business.
     */
    private static final String KIND_CAMERA = "camera";
    private static final String KIND_MICROPHONE = "microphone";

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

    /**
     * Who is asked when something needs permission, and how the answer
     * arrives.
     *
     * Two quite different questions, in a deliberate order. Whether the *site*
     * may have the camera is Tenna's to ask, of the user, once per site, and
     * it is remembered per site the way a browser remembers it per origin.
     * Whether *Tenna* may have the camera is Android's, asked of the user
     * once, and remembered for the app. The site's question comes first: there
     * is no sense putting the system's prompt in front of somebody who has not
     * yet agreed that this site should have it at all.
     *
     * Both are answered on the main thread, whenever the answer is known —
     * which may be after a prompt, a system dialog, and a trip through the
     * bridge.
     */
    interface Consent {
        /** Whether this site may reach these capabilities. */
        void forSite(@NonNull String[] kinds, @NonNull Decision decision);

        /** Whether Tenna holds the Android permissions to provide them. */
        void forApp(@NonNull String[] permissions, @NonNull Decision decision);
    }

    /** The answer to something that had to be asked. */
    interface Decision {
        void decided(boolean granted);
    }

    /**
     * Where a site's fullscreen video goes, and where it comes back from.
     *
     * The view itself is Chromium's; all that is asked here is somewhere to
     * put it. Which frame that is matters — see {@link #onShowCustomView} —
     * and the frame belongs to the plugin, so it answers this.
     */
    interface Stage {
        /** Show {@code view} over the site, or take away whatever is there. */
        void present(@Nullable View view);
    }

    /** Room around the field in a `prompt`, in dp. */
    private static final int PROMPT_PADDING_DP = 20;

    private final Activity activity;
    private final Launcher launcher;
    private final Consent consent;
    private final Stage stage;

    /** What the site is called, for the dialogs it opens. */
    @Nullable private final String siteName;

    /** The chooser Chromium is blocked on, or null when there is none. */
    @Nullable private ValueCallback<Uri[]> pending;

    /** The dialog the site has on screen, so it can be taken down with it. */
    @Nullable private AlertDialog dialog;

    /** What that dialog answers with if it leaves the screen unanswered. */
    @Nullable private Runnable refusal;

    /** How to give a fullscreen view back, or null when nothing is up. */
    @Nullable private CustomViewCallback fullscreen;

    /** The `getUserMedia` being decided, or null when none is. */
    @Nullable private PermissionRequest media;

    NsiteChromeClient(
        @NonNull Activity activity,
        @Nullable String siteName,
        @NonNull Launcher launcher,
        @NonNull Consent consent,
        @NonNull Stage stage
    ) {
        this.activity = activity;
        this.siteName = siteName;
        this.launcher = launcher;
        this.consent = consent;
        this.stage = stage;
    }

    /**
     * Give up on anything outstanding, because the window is going away.
     *
     * Called when the site's WebView is destroyed. The picker it opened may
     * still be on screen and will still return, to a callback that is by then
     * nobody's; answering now is what keeps that from being a leak. A dialog
     * has to come down for a plainer reason besides — a window left on screen
     * after the activity it belongs to is gone is a leak the system reports.
     *
     * Called before the frame and the system bars are given back, so that a
     * site closed mid-video is a site that returns them.
     */
    void release() {
        answer(null);
        dismiss();
        onHideCustomView();
        refuseMedia();
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
        // a request, not a requirement — a device with no camera app, or a
        // user who would rather not, falls through to the picker, which is
        // what a browser does with it too.
        //
        // No prompt of Tenna's here, unlike `getUserMedia`. Nothing is handed
        // to the site but the one photo, and it was the user who pressed the
        // button that opened the camera. Android's own permission is still
        // needed — see `withCamera`.
        if (params.isCaptureEnabled()) {
            final boolean video = accept.contains("video/*");
            if (video || accept.contains("image/*")) {
                withCamera(granted -> {
                    if (granted && (video ? captureVideo() : capturePhoto())) return;
                    pick(params);
                });
                return true;
            }
        }

        pick(params);
        return true;
    }

    /**
     * Hold Android's camera permission, or find out that we don't.
     *
     * Needed only because Tenna now declares `CAMERA` at all, for
     * `getUserMedia`. Android requires the runtime grant for
     * `ACTION_IMAGE_CAPTURE` from apps that declare the permission and from no
     * others — so adding it for one feature quietly took the other away, and
     * this gives it back.
     */
    private void withCamera(@NonNull Decision decision) {
        consent.forApp(new String[] { Manifest.permission.CAMERA }, decision);
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

    // -----------------------------------------------------------------------
    // Camera and microphone
    // -----------------------------------------------------------------------

    /**
     * A site calling `getUserMedia`.
     *
     * The default {@link WebChromeClient} denies this outright, which is why
     * a site's camera button did nothing: the page got `NotAllowedError` with
     * nobody having been asked. Capacitor's client goes the other way and
     * grants whatever the app's manifest declares, without asking either —
     * neither is an answer a person had any part in.
     *
     * So it is put to the user, twice over and in order: whether this site may
     * have it, and then whether Tenna may. See {@link Consent}.
     *
     * All of it or none of it. `getUserMedia({video, audio})` fails whole if
     * either half is refused, so a half grant would only produce a failure the
     * user had apparently agreed to — and a site asking for the microphone
     * while the user thought they were allowing the camera is exactly the
     * confusion worth refusing.
     */
    @Override
    public void onPermissionRequest(PermissionRequest request) {
        final String[] resources = request.getResources();
        final List<String> kinds = new ArrayList<>(2);

        for (String resource : resources) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                kinds.add(KIND_CAMERA);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                kinds.add(KIND_MICROPHONE);
            } else {
                // Protected media identifiers, MIDI: things with no prompt of
                // their own and nothing to weigh. A request Tenna has no way
                // to put to the user is not one it can grant on their behalf.
                Log.i(TAG, "Refused a site's request for " + resource);
                request.deny();
                return;
            }
        }

        if (kinds.isEmpty()) {
            request.deny();
            return;
        }

        // Only one at a time, and the newest wins. A site that asks again
        // before the first was answered has abandoned the first.
        refuseMedia();
        media = request;

        consent.forSite(kinds.toArray(new String[0]), forSite -> {
            if (media != request) return;

            if (!forSite) {
                media = null;
                request.deny();
                return;
            }

            consent.forApp(permissionsFor(kinds), forApp -> {
                if (media != request) return;
                media = null;

                if (forApp) request.grant(resources);
                else request.deny();
            });
        });
    }

    /**
     * The request went away on its own — a navigation, or the page dropping it.
     *
     * Cleared rather than denied: the object is spent, and denying a request
     * Chromium has already withdrawn does nothing but risk an exception.
     */
    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
        if (media == request) media = null;
    }

    /** Turn down whatever `getUserMedia` is outstanding, if any. */
    private void refuseMedia() {
        PermissionRequest request = media;
        media = null;
        if (request != null) request.deny();
    }

    /** What Android calls the capabilities the site named. */
    @NonNull
    private static String[] permissionsFor(@NonNull List<String> kinds) {
        List<String> permissions = new ArrayList<>(2);
        if (kinds.contains(KIND_CAMERA)) permissions.add(Manifest.permission.CAMERA);
        // MODIFY_AUDIO_SETTINGS is declared alongside this but is not a
        // runtime permission, so it is never asked for.
        if (kinds.contains(KIND_MICROPHONE)) permissions.add(Manifest.permission.RECORD_AUDIO);
        return permissions.toArray(new String[0]);
    }

    // -----------------------------------------------------------------------
    // Fullscreen
    // -----------------------------------------------------------------------

    /**
     * Take a site's video fullscreen.
     *
     * The view Chromium hands over goes into the site's own frame, not the
     * activity's content view. The frame is what a permission prompt conceals,
     * what the shutoff animates and what the window is torn down with, and a
     * video outside it would survive all three — which is how Capacitor's own
     * chrome client behaves, and is wrong here for the same reason the rest of
     * this class is not Capacitor's.
     */
    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        // Chromium doesn't nest these, but if it ever did the earlier view is
        // the stale one and has to be given back rather than stranded.
        if (fullscreen != null) onHideCustomView();

        fullscreen = callback;
        stage.present(view);
    }

    @Override
    public void onHideCustomView() {
        CustomViewCallback callback = fullscreen;
        fullscreen = null;

        stage.present(null);
        // Last, because it lets Chromium free the view that was just removed.
        if (callback != null) callback.onCustomViewHidden();
    }

    // -----------------------------------------------------------------------
    // JavaScript dialogs
    // -----------------------------------------------------------------------

    @Override
    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
        // An alert has nothing to disagree with, so dismissing it and pressing
        // its one button mean the same thing.
        show(dialog(message).setPositiveButton(android.R.string.ok, answering(result::confirm)),
            result::confirm);
        return true;
    }

    @Override
    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
        show(dialog(message)
            .setPositiveButton(android.R.string.ok, answering(result::confirm))
            .setNegativeButton(android.R.string.cancel, answering(result::cancel)),
            result::cancel);
        return true;
    }

    @Override
    public boolean onJsPrompt(
        WebView view,
        String url,
        String message,
        String defaultValue,
        JsPromptResult result
    ) {
        final EditText field = new EditText(activity);
        field.setText(defaultValue == null ? "" : defaultValue);
        field.setSelection(field.getText().length());

        show(dialog(message)
            .setView(padded(field))
            .setPositiveButton(android.R.string.ok,
                answering(() -> result.confirm(field.getText().toString())))
            .setNegativeButton(android.R.string.cancel, answering(result::cancel)),
            result::cancel);
        return true;
    }

    /**
     * The shape every dialog a site opens takes.
     *
     * Titled with the site's name, because a modal drawn over a window with no
     * address bar in it has nothing else to say whose words these are. A site
     * that could put an unattributed box on screen could put Tenna's words in
     * it.
     *
     * The message is the site's own and is set as text — never as anything the
     * dialog would read as markup.
     */
    @NonNull
    private AlertDialog.Builder dialog(@Nullable String message) {
        String name = siteName == null || siteName.trim().isEmpty()
            ? activity.getString(R.string.nsite_dialog_anonymous)
            : siteName;

        return new AlertDialog.Builder(activity, R.style.NsiteDialog)
            .setTitle(activity.getString(R.string.nsite_dialog_title, name))
            .setMessage(message == null ? "" : message);
    }

    /**
     * Put a site's dialog on screen, and hold the page to a single answer.
     *
     * {@code refusal} is what the page is told if the dialog leaves without
     * one — a press of the back button, or the window closing under it.
     * Chromium blocks the renderer on a JavaScript dialog until it is answered
     * exactly once, so a dismissal that answered nothing would be a site
     * frozen for good, and a second answer after a button press would take the
     * renderer down.
     */
    private void show(@NonNull AlertDialog.Builder builder, @NonNull Runnable refusal) {
        // At most one at a time. Chromium won't ask for a second while the
        // first is up, but a dialog stranded by a reload would sit there.
        dismiss();

        this.refusal = refusal;

        final AlertDialog shown = builder.create();
        shown.setOnDismissListener(dismissed -> {
            if (dialog == shown) dialog = null;
            refuse();
        });

        dialog = shown;
        shown.show();
    }

    /** A button: the answer it gives, and the end of the refusal. */
    @NonNull
    private DialogInterface.OnClickListener answering(@NonNull Runnable answer) {
        return (dismissed, which) -> {
            // Before answering, so the dismissal this press causes finds
            // nothing left to refuse with.
            refusal = null;
            answer.run();
        };
    }

    /** Tell the page no, if nothing has told it anything yet. */
    private void refuse() {
        Runnable pending = refusal;
        refusal = null;
        if (pending != null) pending.run();
    }

    /** Take down whatever dialog is up, answering it on the way. */
    private void dismiss() {
        AlertDialog shown = dialog;
        dialog = null;
        // `refuse` runs from the dismiss listener, so the page is answered
        // even though nobody pressed anything.
        if (shown != null) shown.dismiss();
    }

    /** A field with room around it, rather than flush to the dialog's edges. */
    @NonNull
    private ViewGroup padded(@NonNull EditText field) {
        int padding = (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            PROMPT_PADDING_DP,
            activity.getResources().getDisplayMetrics()
        );

        FrameLayout room = new FrameLayout(activity);
        room.setPadding(padding, 0, padding, 0);
        room.addView(field, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ));
        return room;
    }
}
