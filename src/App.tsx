// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from 'unhead/plugins';
import { Suspense } from 'react';
import NostrProvider from '@/components/NostrProvider';
import { NativeKeys } from '@/components/NativeKeys';
import { NostrSync } from '@/components/NostrSync';
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { ThemeBackground } from '@/components/ThemeBackground';
import { AppConfig } from '@/contexts/AppContext';
import { APP_RELAYS } from '@/lib/appRelays';
import { secureStorage } from '@/lib/secureStorage';
import AppRouter from './AppRouter';

const head = createHead({
  plugins: [
    InferSeoMetaPlugin(),
  ],
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: Infinity,
    },
  },
});

const defaultConfig: AppConfig = {
  // Tenna's chrome is dark at every screen, so the theme has to agree: it
  // drives the shadcn surfaces and, on native, the system bar icon style.
  // A logged-in user's own Ditto theme overrules it — see `profileTheme`.
  theme: "dark",
  // Nobody's theme until somebody signs in and turns out to have published one.
  profileTheme: null,
  relayMetadata: APP_RELAYS,
  blossomServerMetadata: {
    servers: [
      'https://blossom.ditto.pub/',
      'https://blossom.dreamith.to/',
      'https://blossom.primal.net/',
    ],
    updatedAt: 0,
  },
  useAppBlossomServers: true,
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="nostr:app-config" defaultConfig={defaultConfig}>
        {/*
          The wallpaper a theme brings with it, under everything and outside
          the router — it is behind the wall, behind a dialog, and behind the
          screen the app paints while it works out what this launch is.
        */}
        <ThemeBackground />
        <QueryClientProvider client={queryClient}>
          {/*
            Logins go to the Keychain on iOS and the KeyStore on Android, not
            to localStorage. An nsec login is the whole account — there is no
            reset for one that leaks — and Tenna is a browser for other
            people's sites, so its own origin holds the key that every site it
            opens will ask to sign with. `secureStorage` falls back to
            localStorage on the web, where there is nowhere better to put it,
            and migrates a key it finds there on the first native read.

            On Android there is no key here to store: an `x-native-key` login
            is a pubkey, and the key itself is in the app process. This still
            matters for the rest of it — the login list is who the user is,
            and a bunker login's client key is a real secret.

            That read is a trip to the keychain, so it is asynchronous, and
            the provider shows the fallback until it lands. The fallback is
            the same empty dark screen `AppRouter` paints while it works out
            whether this launch is a site — anything else, including the
            default of nothing at all, flashes an unpainted screen on the way
            in.
          */}
          <NostrLoginProvider
            storageKey='nostr:login'
            storage={secureStorage}
            fallback={<div className="min-h-screen bg-background" />}
          >
            <NostrProvider>
              <NostrSync />
              {/*
                And on Android the key does not stay here either: it is handed
                to the app process, sealed under the KeyStore, and signed with
                over the bridge. A login that predates that is moved across on
                sight, and a key whose account has been signed out of is taken
                back off the device. See `NativeKeys`.
              */}
              <NativeKeys />
              <TooltipProvider>
                <Toaster />
                <Suspense>
                  <AppRouter />
                </Suspense>
              </TooltipProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
