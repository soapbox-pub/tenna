import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // Tenna's own subclass, not the stock one: the root view controller is
        // built here rather than taken from Main.storyboard, so this is the
        // only place that decides which bridge the app runs on — and the
        // bridge is where Tenna's plugins are registered. See
        // `TennaBridgeViewController`.
        window?.rootViewController = TennaBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // A background refresh request only lives as long as nobody replaces
        // it, and leaving is the last moment to make sure one is in. See
        // `NappPeriodicSync`.
        NappPeriodicSync.schedule()
    }
}
