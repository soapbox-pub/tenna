import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { AppInfo } from 'capacitor-plugin-nostr-signer';
import { Loader2 } from 'lucide-react';

import { useLoginActions } from '@/hooks/useLoginActions';
import { AndroidNativeSigner } from '@/lib/androidNativeSigner';

interface AndroidSignerOptionsProps {
  /** Called once a signer app has answered and the login is active. */
  onLogin: () => void;
}

/**
 * The NIP-55 signer apps installed on this device, offered as ways in.
 *
 * This is the best login Tenna can offer on Android: the key stays in the
 * other app, and every site Tenna opens signs through it rather than through
 * a key sitting in this process. Which is why it goes above the nsec field
 * rather than under a menu.
 *
 * Renders nothing at all off Android, or when the device has no signer
 * installed, so it is safe to mount unconditionally.
 */
export function AndroidSignerOptions({ onLogin }: AndroidSignerOptionsProps) {
  const isAndroidNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [connectingPkg, setConnectingPkg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const login = useLoginActions();

  useEffect(() => {
    if (!isAndroidNative) return;
    let cancelled = false;

    AndroidNativeSigner.getSignerApps()
      .then((list) => {
        if (!cancelled) setApps(list);
      })
      .catch((e) => {
        if (cancelled) return;
        // The plugin throws when nothing on the device answers the
        // `nostrsigner:` intent. That is the ordinary case for most
        // devices, not a failure — it just means there is nothing to show.
        console.warn('Failed to enumerate Android signer apps:', e);
        setApps([]);
      });

    return () => {
      cancelled = true;
    };
  }, [isAndroidNative]);

  if (!isAndroidNative) return null;
  // Nothing while the probe is out, rather than a spinner that would flash
  // for the instant it takes and leave a gap above the form either way.
  if (apps === null) return null;
  if (apps.length === 0) return null;

  const handleConnect = async (app: AppInfo) => {
    setError(null);
    setConnectingPkg(app.packageName);
    try {
      await login.androidSigner(app.packageName);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnectingPkg(null);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {apps.map((app) => {
          const connecting = connectingPkg === app.packageName;
          return (
            <button
              key={app.packageName}
              type="button"
              onClick={() => handleConnect(app)}
              disabled={connectingPkg !== null}
              className="w-full flex items-center gap-3 rounded-xl border border-input bg-background px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {app.iconUrl ? (
                <img
                  src={app.iconUrl}
                  alt=""
                  className="size-8 rounded-md shrink-0"
                  decoding="async"
                />
              ) : (
                <div className="size-8 rounded-md bg-muted shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">
                  {connecting ? 'Connecting…' : `Log in with ${app.name}`}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  Your key stays in {app.name}.
                </div>
              </div>
              {connecting && (
                <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
