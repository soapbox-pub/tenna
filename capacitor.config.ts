import type { CapacitorConfig } from '@capacitor/cli';

// ── Fill in your app identity before running `npx cap add android` / `ios`. ──
// The appId must be a reverse-DNS-style identifier (e.g. `com.example.myapp`)
// and cannot be changed later without re-registering the app with the stores.

const config: CapacitorConfig = {
  appId: 'pub.soapbox.tenna',
  appName: 'Tenna',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // No `iosScheme`. Capacitor serves the app off a scheme it registers a
    // WKURLSchemeHandler for, and WKWebView already owns http and https, so
    // they are the two values this may not take — setting it to 'https' here
    // was silently ignored and the app loaded from `capacitor://localhost`
    // regardless. Android has no such restriction, which is why
    // `androidScheme` above is real and this is not.
    //
    // It is not cosmetic. WebKit exposes `navigator.serviceWorker` only to
    // http(s) documents, and a custom-scheme top level withholds it from the
    // whole frame tree — including cross-origin https children. That is why
    // the iframe.diy sandbox never completes its handshake on iOS: the frame
    // sends `ready` only `if ("serviceWorker" in navigator)`. See `Nsite`.
  },
  android: {
    // Disallow loading mixed-content (http:// inside https://).
    allowMixedContent: false,
    // Background color shown behind the web view before first paint.
    // Usually your app's dark-theme background so the splash feels seamless.
    backgroundColor: '#150609',
    // Leave the service worker client alone. There is exactly one per
    // process, and Capacitor's — which answers only for `localhost` and
    // returns nothing for anything else — would replace Tenna's the moment
    // a bridge was built, which is what serves every nsite's worker. See
    // `NsiteServiceWorkers`. Tenna itself registers no service worker, so
    // nothing is given up by turning this off.
    resolveServiceWorkerRequests: false,
  },
  ios: {
    backgroundColor: '#150609',
    // `never` prevents WKWebView from inset-adjusting scroll content — the
    // app handles safe-area insets itself in CSS via env(safe-area-inset-*).
    contentInset: 'never',
    // No `scheme` key here. Despite the name it is not a URL scheme at all —
    // it names the *Xcode build scheme* `npx cap run ios` should build, and
    // the generated project's only scheme is `App`, so naming anything else
    // breaks that command. The deep-link schemes are declared where they
    // actually belong, in `CFBundleURLTypes` in `ios/App/App/Info.plist`.
  },
  plugins: {
    SystemBars: {
      // Inject --safe-area-inset-* CSS variables on Android to work around
      // a Chromium bug (<140) where env(safe-area-inset-*) reports 0.
      insetsHandling: 'css',
    },
  },
};

export default config;
