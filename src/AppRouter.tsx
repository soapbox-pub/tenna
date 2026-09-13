import { BrowserRouter, Route, Routes } from "react-router-dom";
import { DeepLinkHandler } from "./components/DeepLinkHandler";
import { ScrollToTop } from "./components/ScrollToTop";
import { useNsiteLaunch } from "@/hooks/useNsiteLaunch";
import { isSignerSheet, useSignerPrompt } from "@/hooks/useSignerPrompt";

import { AuthorizedAppsPage } from "./pages/AuthorizedAppsPage";
import Index from "./pages/Index";
import { NIP19Page } from "./pages/NIP19Page";
import NotFound from "./pages/NotFound";
import { NsiteApp } from "./pages/NsiteApp";
import { SettingsPage } from "./pages/SettingsPage";
import { SignerPrompt } from "./pages/SignerPrompt";

export function AppRouter() {
  const { pending, launch } = useNsiteLaunch();
  const signer = useSignerPrompt();

  // Another application asking to sign something isn't a route either, and for
  // a stronger reason than a site: that window is not the app. Its whole life
  // is one question, put by whatever opened it, and it closes when the
  // question is answered.
  //
  // Asked first because it is the cheaper question — the plugin behind it only
  // exists in the window that has a request in it, so everywhere else it
  // resolves without a bridge call at all.
  if (signer.pending) return null;
  if (signer.request) {
    return <SignerPrompt request={signer.request} onResolve={signer.resolve} />;
  }

  // Answered, and the window is on its way out — or it is holding another
  // request that has not arrived from the app process yet. Either way there is
  // nothing here to fall back to, and falling back to the router put a page
  // nobody asked for on screen behind a sheet on its way down: the sheet is
  // dragged, the request clears, and for a few frames the whole app renders
  // whatever `/` in that window resolves to.
  if (isSignerSheet()) return null;

  // A site opened from its own home screen shortcut isn't a route and never
  // was — Tenna has no URL for an nsite, and the task the launcher started
  // belongs to the site rather than to the browser around it. So this launch
  // of the app is the site, and there is no router in it at all.
  //
  // The question is asked before the first paint because the answer decides
  // what the app *is*; rendering the channel wall for a frame and then
  // replacing it would flash a home screen the user never asked for.
  if (pending) return <div className="min-h-screen bg-background" />;
  if (launch) return <NsiteApp launch={launch} />;

  return (
    <BrowserRouter>
      <DeepLinkHandler />
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Index />} />
        {/* Static, so it outranks the identifier route below whatever the
            order here — but written above it anyway, since a reader ranks by
            order and React Router does not. */}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/apps" element={<AuthorizedAppsPage />} />
        {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
        <Route path="/:nip19" element={<NIP19Page />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;
