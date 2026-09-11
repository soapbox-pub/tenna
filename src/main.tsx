import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { bootstrapNative } from '@/lib/nativeBootstrap';
import App from './App.tsx';
import './index.css';

/**
 * Refuse to run inside somebody else's frame.
 *
 * `frame-ancestors` is the directive for this and it is ignored in a meta tag
 * — and a meta tag is all there is, because the web build is served as an
 * nsite from content-addressed blobs through gateways that set no headers of
 * their own. So the check is made here instead.
 *
 * What it protects is the click. Tenna holds an nsec and asks the user plain
 * yes-or-no questions about signing with it; framed and overlaid, a page can
 * make "Allow" land under whatever the user thinks they are pressing. Nothing
 * renders until this has passed.
 */
if (window.top !== window.self) {
  document.documentElement.textContent =
    'Tenna will not run inside a frame.';
} else {
  bootstrapNative();

  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
