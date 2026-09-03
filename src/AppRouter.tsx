import { BrowserRouter, Route, Routes } from "react-router-dom";
import { DeepLinkHandler } from "./components/DeepLinkHandler";
import { ScrollToTop } from "./components/ScrollToTop";
import { useNsiteLaunch } from "@/hooks/useNsiteLaunch";

import Index from "./pages/Index";
import { NIP19Page } from "./pages/NIP19Page";
import NotFound from "./pages/NotFound";
import { NsiteApp } from "./pages/NsiteApp";

export function AppRouter() {
  const { pending, launch } = useNsiteLaunch();

  // A site opened from its own home screen shortcut isn't a route and never
  // was — Tenna has no URL for an nsite, and the task the launcher started
  // belongs to the site rather than to the browser around it. So this launch
  // of the app is the site, and there is no router in it at all.
  //
  // The question is asked before the first paint because the answer decides
  // what the app *is*; rendering the channel wall for a frame and then
  // replacing it would flash a home screen the user never asked for.
  if (pending) return <div className="min-h-screen bg-[#150609]" />;
  if (launch) return <NsiteApp launch={launch} />;

  return (
    <BrowserRouter>
      <DeepLinkHandler />
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Index />} />
        {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
        <Route path="/:nip19" element={<NIP19Page />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;
