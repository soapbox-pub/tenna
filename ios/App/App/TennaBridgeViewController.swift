import Capacitor
import UIKit

/**
 The view controller the app boots into, and the one place Tenna's own plugins
 are registered.

 Registration is in code rather than left to discovery, and that is deliberate.
 Capacitor finds plugins by reading `packageClassList` out of the generated
 `capacitor.config.json`, and the CLI builds that list by scanning *installed
 npm packages* for `@objc` classes — `ios/App/App` is never looked at. So an
 app-local plugin either registers itself here or is not registered at all, and
 a copy of its name added to the generated file by hand would be wiped by the
 next `npx cap sync ios`, which regenerates it. Ditto has that bug; this is how
 not to inherit it.

 `registerPluginInstance` rather than the `registerPluginType` the docs point
 at, because that one opens with `if autoRegisterPlugins { return }` and
 auto-registration is on by default — so it is a silent no-op in any app that
 has not turned discovery off wholesale, and the plugin simply never appears.
 Registering the instance takes the same path every discovered plugin takes,
 minus the discovery.
 */
class TennaBridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NsiteWebViewPlugin())
        bridge?.registerPluginInstance(NappPushPlugin())
        bridge?.registerPluginInstance(TennaSignerPlugin())
    }
}
