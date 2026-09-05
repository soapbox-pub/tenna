// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from 'unhead/plugins';
import { Suspense } from 'react';
import NostrProvider from '@/components/NostrProvider';
import { NostrSync } from '@/components/NostrSync';
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
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
  theme: "dark",
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
        <QueryClientProvider client={queryClient}>
          {/*
            Logins go to the Keychain on iOS and the KeyStore on Android, not
            to localStorage. An nsec login is the whole account — there is no
            reset for one that leaks — and Tenna is a browser for other
            people's sites, so its own origin holds the key that every site it
            opens will ask to sign with. `secureStorage` falls back to
            localStorage on the web, where there is nowhere better to put it,
            and migrates a key it finds there on the first native read.

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
            fallback={<div className="min-h-screen bg-[#150609]" />}
          >
            <NostrProvider>
              <NostrSync />
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
