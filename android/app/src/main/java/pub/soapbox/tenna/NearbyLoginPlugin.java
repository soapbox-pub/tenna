package pub.soapbox.tenna;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Log a computer in as the account on this phone. See {@link NearbyLogin}.
 *
 * <p>The web layer starts it and draws the progress; it never decides that the
 * key goes. That is asked here, in a prompt the system draws — the device
 * credential where there is one, which also makes sure it is the phone's owner
 * holding it — with the code on it. A renderer that has been taken over can
 * start a login, but the person looking at the prompt is the one who ends it.
 *
 * <p>Android only. iOS has no {@code NearbyLogin}, and the settings row that
 * opens it isn't drawn there.
 */
@CapacitorPlugin(
    name = "NearbyLogin",
    permissions = {
        @Permission(
            alias = NearbyLoginPlugin.BLUETOOTH,
            strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT }
        ),
        // Before Android 12, finding a Bluetooth device counted as finding out
        // where the phone is.
        @Permission(alias = NearbyLoginPlugin.LOCATION, strings = { Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class NearbyLoginPlugin extends Plugin {

    static final String BLUETOOTH = "bluetooth";
    static final String LOCATION = "location";

    private NearbyLogin login;
    private PluginCall pending;

    /** Whatever is on screen asking the user, so a failure can take it down. */
    private CancellationSignal prompt;
    private AlertDialog dialog;

    private static String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? BLUETOOTH : LOCATION;
    }

    /**
     * Find a computer waiting for a login and, if the user approves, send it
     * the key of {@code pubkey}. Resolves with {@code computer} once it has
     * been sent; progress arrives as {@code status} events.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String pubkey = call.getString("pubkey");
        if (pubkey == null || !TennaKeys.has(getContext(), pubkey)) {
            call.reject("This account's key isn't on this phone.");
            return;
        }
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            begin(call, pubkey);
        } else {
            requestPermissionForAlias(alias(), call, "onPermission");
        }
    }

    @PermissionCallback
    private void onPermission(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Tenna needs permission to find nearby devices.", "PERMISSION_DENIED");
            return;
        }
        begin(call, call.getString("pubkey"));
    }

    /** Stop looking, or take back a prompt the user hasn't answered. */
    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (login != null) login.cancel();
            settle(null, "Canceled");
            call.resolve();
        });
    }

    private void begin(PluginCall call, String pubkey) {
        getActivity().runOnUiThread(() -> {
            if (login != null) login.cancel();
            settle(null, "Canceled");
            pending = call;

            final NearbyLogin[] self = new NearbyLogin[1];
            self[0] = new NearbyLogin(getContext(), pubkey, new NearbyLogin.Listener() {
                @Override
                public void onStatus(@NonNull String state) {
                    if (login != self[0]) return;
                    JSObject event = new JSObject();
                    event.put("state", state);
                    notifyListeners("status", event);
                }

                @Override
                public void onCode(@NonNull String code, @NonNull String computer) {
                    if (login != self[0]) return;
                    JSObject event = new JSObject();
                    event.put("state", "comparing");
                    event.put("code", code);
                    event.put("computer", computer);
                    notifyListeners("status", event);
                    confirm(self[0], pubkey, code, computer);
                }

                @Override
                public void onSent(@NonNull String computer) {
                    if (login != self[0]) return;
                    JSObject result = new JSObject();
                    result.put("computer", computer);
                    settle(result, null);
                }

                @Override
                public void onFailed(@NonNull String message) {
                    if (login != self[0]) return;
                    settle(null, message);
                }
            });
            login = self[0];
            login.start();
        });
    }

    /** Resolve or reject the call in flight, and take down any prompt. */
    private void settle(JSObject result, String failure) {
        if (prompt != null) {
            prompt.cancel();
            prompt = null;
        }
        if (dialog != null) {
            dialog.dismiss();
            dialog = null;
        }
        PluginCall call = pending;
        pending = null;
        login = null;
        if (call == null) return;
        if (result != null) call.resolve(result);
        else call.reject(failure, "Canceled".equals(failure) ? "CANCELED" : null);
    }

    // ── Asking ───────────────────────────────────────────────────────────────

    private void confirm(NearbyLogin target, String pubkey, String code, String computer) {
        Activity activity = getActivity();
        String spaced = code.substring(0, 3) + " " + code.substring(3);
        String account = TennaAccounts.nameOf(getContext(), pubkey);
        String title = "Log in on " + computer + "?";
        String warning = computer + " gets the key to " + account
                + ", and can do anything as you until you sign out there.";

        Runnable approve = () -> {
            prompt = null;
            dialog = null;
            if (login == target) target.approve();
        };
        Runnable refuse = () -> {
            if (login != target) return;
            target.cancel();
            settle(null, "Canceled");
        };

        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && keyguard != null && keyguard.isDeviceSecure()) {
            askWithCredential(activity, title, "Only if it shows " + spaced, warning, approve, refuse);
        } else {
            dialog = new AlertDialog.Builder(activity, R.style.NsiteDialog)
                    .setTitle(title)
                    .setMessage("Only if it shows " + spaced + ".\n\n" + warning)
                    .setPositiveButton("Send key", (d, which) -> approve.run())
                    .setNegativeButton("Cancel", (d, which) -> refuse.run())
                    .setOnCancelListener(d -> refuse.run())
                    .show();
        }
    }

    @SuppressWarnings("deprecation")
    private void askWithCredential(
            Activity activity, String title, String subtitle, String description, Runnable approve, Runnable refuse) {
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
                .setTitle(title)
                .setSubtitle(subtitle)
                .setDescription(description)
                .setConfirmationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        } else {
            builder.setDeviceCredentialAllowed(true);
        }

        prompt = new CancellationSignal();
        builder.build().authenticate(prompt, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                approve.run();
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence message) {
                // Includes our own cancel(), which has already settled.
                prompt = null;
                refuse.run();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (login != null) login.cancel();
        settle(null, "Canceled");
    }
}
