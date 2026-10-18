package pub.soapbox.tenna;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.annotation.NonNull;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;

/**
 * Hands the key of an account on this phone to a computer across the room.
 *
 * <p>The computer is Din, whose login screen advertises a Bluetooth LE service
 * for exactly this (its side is {@code electron/bluetooth-login.mts}). Typing
 * an nsec on a computer that has just booted is miserable, and this is a phone
 * that already has the key.
 *
 * <p>This is the export {@link TennaKeys} says there is none of, and it keeps
 * the terms that class set for one. The key never reaches the web layer: it is
 * read here, encrypted here, and written to the radio from here. And it does
 * not leave without a confirmation the renderer cannot forge — the plugin puts
 * up the system's own prompt, with the code on it, and only its answer calls
 * {@link #approve}.
 *
 * <p>Bluetooth's pairing is not what protects it. The only pairing a phone and
 * a computer can do without typing a PIN is "Just Works", which anybody in
 * radio range can sit in the middle of. So the link is left plain and the
 * protocol carries its own defense, the way LE Secure Connections numeric
 * comparison does:
 *
 * <ol>
 *   <li>Read {@code session}: D, the computer's ephemeral key, then its name.
 *   <li>Write {@code hello}: P, an ephemeral key of ours, and SHA-256 of a
 *       nonce we have not shown yet.
 *   <li>Read {@code nonce}: the computer's nonce, made only now.
 *   <li>Write {@code reveal}: our nonce, which the computer checks against
 *       what we committed to.
 *   <li>Both sides show six digits of SHA-256 over all four. Someone in the
 *       middle has to pick their keys before seeing both nonces, so the codes
 *       on the two screens agree for them one time in a million, not by
 *       choice.
 *   <li>Once the user has compared them and said yes: write {@code key}, a
 *       two-byte length and a NIP-44 payload of the secret key under the
 *       conversation key of P and D.
 * </ol>
 *
 * <p>Everything runs on the main thread; the GATT callbacks only post to it.
 * Permissions are the plugin's business, checked before this is made.
 */
@SuppressLint("MissingPermission")
final class NearbyLogin {

    static final UUID SERVICE = UUID.fromString("52687ca1-3eb0-4325-a3dc-cd3738f77499");
    private static final UUID SESSION = UUID.fromString("52687ca2-3eb0-4325-a3dc-cd3738f77499");
    private static final UUID HELLO = UUID.fromString("52687ca3-3eb0-4325-a3dc-cd3738f77499");
    private static final UUID NONCE = UUID.fromString("52687ca4-3eb0-4325-a3dc-cd3738f77499");
    private static final UUID REVEAL = UUID.fromString("52687ca5-3eb0-4325-a3dc-cd3738f77499");
    private static final UUID KEY = UUID.fromString("52687ca6-3eb0-4325-a3dc-cd3738f77499");

    private static final byte[] CODE_CONTEXT = "din-login-v1".getBytes(StandardCharsets.UTF_8);

    /** Room for the key payload in one write; BlueZ goes up to 517. */
    private static final int MTU = 247;

    private static final long SCAN_MS = 30_000;
    private static final long STEP_MS = 15_000;

    /**
     * Connecting fails now and then for no reason the stack will name (status
     * 133, "failed establishment"), and the cure everyone uses is to try again.
     */
    private static final int CONNECT_TRIES = 4;

    private static final SecureRandom RANDOM = new SecureRandom();

    /** What the plugin hears. Every call comes on the main thread. */
    interface Listener {
        /** {@code scanning}, {@code connecting} or {@code sending}. */
        void onStatus(@NonNull String state);

        /** The codes are ready: ask the user, then call {@link #approve} or {@link #cancel}. */
        void onCode(@NonNull String code, @NonNull String computer);

        void onSent(@NonNull String computer);

        void onFailed(@NonNull String message);
    }

    private enum Step { SCAN, CONNECT, DISCOVER, SESSION, HELLO, NONCE, REVEAL, CONFIRM, SEND, DONE }

    private final Context context;
    private final String pubkey;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private Step step = Step.SCAN;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothDevice device;
    private int tries;

    private byte[] din;
    private String computer = "your computer";
    private byte[] phoneSk;
    private byte[] phonePk;
    private byte[] phoneNonce;
    private byte[] dinNonce;

    private final Runnable timeout = () -> fail(step == Step.SCAN
            ? "No computer nearby is waiting for a login. Choose Log in with your phone on it first."
            : "The computer stopped answering.");

    NearbyLogin(@NonNull Context context, @NonNull String pubkey, @NonNull Listener listener) {
        this.context = context.getApplicationContext();
        this.pubkey = pubkey;
        this.listener = listener;
    }

    // ── Driving it ──────────────────────────────────────────────────────────

    void start() {
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        if (adapter == null) {
            fail("This phone has no Bluetooth.");
            return;
        }
        if (!adapter.isEnabled()) {
            fail("Turn on Bluetooth and try again.");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            fail("Turn on Bluetooth and try again.");
            return;
        }

        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        listener.onStatus("scanning");
        scanner.startScan(Collections.singletonList(filter), settings, scanCallback);
        main.postDelayed(timeout, SCAN_MS);
    }

    /** The user compared the codes and said yes. */
    void approve() {
        if (step != Step.CONFIRM) return;
        step = Step.SEND;
        listener.onStatus("sending");

        byte[] sk = TennaKeys.get(context, pubkey);
        byte[] conversationKey = NostrCrypto.conversationKey(phoneSk, NostrCrypto.bytesToHex(din));
        byte[] nonce = new byte[32];
        RANDOM.nextBytes(nonce);
        byte[] payload = sk != null && conversationKey != null
                ? NostrCipher.encrypt44Bytes(conversationKey, NostrCrypto.bytesToHex(sk), nonce)
                : null;
        if (payload == null) {
            fail("Couldn't read this account's key.");
            return;
        }

        byte[] framed = new byte[2 + payload.length];
        framed[0] = (byte) (payload.length >> 8);
        framed[1] = (byte) payload.length;
        System.arraycopy(payload, 0, framed, 2, payload.length);
        write(KEY, framed);
    }

    /** Stop, quietly: the user said no, or went away. */
    void cancel() {
        finish();
    }

    // ── The handshake ────────────────────────────────────────────────────────

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            main.post(() -> connect(result.getDevice()));
        }

        @Override
        public void onScanFailed(int errorCode) {
            main.post(() -> fail("Couldn't look for computers (error " + errorCode + ")."));
        }
    };

    private void connect(BluetoothDevice found) {
        if (step != Step.SCAN) return;
        step = Step.CONNECT;
        scanner.stopScan(scanCallback);
        listener.onStatus("connecting");
        device = found;
        dial();
    }

    private void dial() {
        tries++;
        rearm();
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> onConnection(status, newState));
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            main.post(NearbyLogin.this::discover);
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> onDiscovered(status));
        }

        // Android 13 hands the value over; earlier versions leave it on the
        // characteristic, and calling the old one is the new one's default.
        @Override
        public void onCharacteristicRead(
                @NonNull BluetoothGatt g, @NonNull BluetoothGattCharacteristic c, @NonNull byte[] value, int status) {
            main.post(() -> onRead(c.getUuid(), value, status));
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            byte[] value = c.getValue();
            main.post(() -> onRead(c.getUuid(), value, status));
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            main.post(() -> onWritten(c.getUuid(), status));
        }
    };

    private void onConnection(int status, int newState) {
        if (step == Step.DONE) return;
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            step = Step.DISCOVER;
            rearm();
            if (!gatt.requestMtu(MTU)) discover();
            return;
        }
        if (newState != BluetoothProfile.STATE_DISCONNECTED) return;
        if (step == Step.CONNECT && tries < CONNECT_TRIES) {
            gatt.close();
            gatt = null;
            main.postDelayed(() -> {
                if (step == Step.CONNECT) dial();
            }, 300);
            return;
        }
        fail(step == Step.CONNECT ? "Couldn't connect to the computer. Try again." : "The computer disconnected.");
    }

    private void discover() {
        if (step != Step.DISCOVER) return;
        if (!gatt.discoverServices()) fail("Couldn't talk to the computer.");
    }

    private void onDiscovered(int status) {
        if (step != Step.DISCOVER) return;
        BluetoothGattService service = status == BluetoothGatt.GATT_SUCCESS ? gatt.getService(SERVICE) : null;
        if (service == null) {
            fail("That computer isn't waiting for a login any more.");
            return;
        }
        step = Step.SESSION;
        read(SESSION);
    }

    private void onRead(UUID uuid, byte[] value, int status) {
        if (status != BluetoothGatt.GATT_SUCCESS || value == null) {
            fail("The computer turned this phone away. If another phone is logging in, wait for it.");
            return;
        }

        if (step == Step.SESSION && uuid.equals(SESSION)) {
            if (value.length < 32) {
                fail("The computer said something this phone doesn't understand.");
                return;
            }
            din = Arrays.copyOfRange(value, 0, 32);
            String name = new String(value, 32, value.length - 32, StandardCharsets.UTF_8).trim();
            if (!name.isEmpty()) computer = name;

            phoneSk = NostrCrypto.generateSecretKey();
            phonePk = NostrCipher.hexToBytes(NostrCrypto.pubkeyOf(phoneSk));
            phoneNonce = new byte[32];
            RANDOM.nextBytes(phoneNonce);

            byte[] hello = new byte[64];
            System.arraycopy(phonePk, 0, hello, 0, 32);
            System.arraycopy(sha256(phoneNonce), 0, hello, 32, 32);
            step = Step.HELLO;
            write(HELLO, hello);
            return;
        }

        if (step == Step.NONCE && uuid.equals(NONCE)) {
            if (value.length != 32) {
                fail("The computer said something this phone doesn't understand.");
                return;
            }
            dinNonce = value.clone();
            step = Step.REVEAL;
            write(REVEAL, phoneNonce);
        }
    }

    private void onWritten(UUID uuid, int status) {
        if (status != BluetoothGatt.GATT_SUCCESS) {
            fail(step == Step.SEND
                    ? "The computer didn't take the key."
                    : "The computer turned this phone away. If another phone is logging in, wait for it.");
            return;
        }

        if (step == Step.HELLO && uuid.equals(HELLO)) {
            step = Step.NONCE;
            read(NONCE);
        } else if (step == Step.REVEAL && uuid.equals(REVEAL)) {
            step = Step.CONFIRM;
            // The user takes as long as they take; the computer gives up on
            // its own, and a disconnect ends this.
            main.removeCallbacks(timeout);
            listener.onCode(comparisonCode(), computer);
        } else if (step == Step.SEND && uuid.equals(KEY)) {
            String name = computer;
            finish();
            listener.onSent(name);
        }
    }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    /** The six digits Din shows too. */
    private String comparisonCode() {
        byte[] digest = sha256(CODE_CONTEXT, din, phonePk, dinNonce, phoneNonce);
        long value = ((digest[0] & 0xffL) << 24) | ((digest[1] & 0xffL) << 16)
                | ((digest[2] & 0xffL) << 8) | (digest[3] & 0xffL);
        return String.format(java.util.Locale.ROOT, "%06d", value % 1_000_000);
    }

    private static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (byte[] part : parts) digest.update(part);
            return digest.digest();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private BluetoothGattCharacteristic characteristic(UUID uuid) {
        BluetoothGattService service = gatt != null ? gatt.getService(SERVICE) : null;
        return service != null ? service.getCharacteristic(uuid) : null;
    }

    private void read(UUID uuid) {
        rearm();
        BluetoothGattCharacteristic c = characteristic(uuid);
        if (c == null || !gatt.readCharacteristic(c)) fail("Couldn't talk to the computer.");
    }

    @SuppressWarnings("deprecation")
    private void write(UUID uuid, byte[] value) {
        rearm();
        BluetoothGattCharacteristic c = characteristic(uuid);
        boolean started = false;
        if (c != null) {
            int type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                started = gatt.writeCharacteristic(c, value, type) == BluetoothStatusCodes.SUCCESS;
            } else {
                c.setWriteType(type);
                c.setValue(value);
                started = gatt.writeCharacteristic(c);
            }
        }
        if (!started) fail("Couldn't talk to the computer.");
    }

    private void rearm() {
        main.removeCallbacks(timeout);
        main.postDelayed(timeout, STEP_MS);
    }

    private void fail(String message) {
        if (step == Step.DONE) return;
        finish();
        listener.onFailed(message);
    }

    private void finish() {
        if (step == Step.DONE) return;
        if (step == Step.SCAN && scanner != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (IllegalStateException ignored) {
                // Bluetooth went off under us; there is no scan to stop.
            }
        }
        step = Step.DONE;
        main.removeCallbacks(timeout);
        if (gatt != null) {
            gatt.disconnect();
            gatt.close();
            gatt = null;
        }
        if (phoneSk != null) Arrays.fill(phoneSk, (byte) 0);
    }
}
