import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set before anything can be delivered, which on a cold launch out of a
        // tap is immediately: without a delegate in place by the time this
        // returns, the tap that started the app is dropped.
        UNUserNotificationCenter.current().delegate = self

        // Before this returns, or iOS has nobody to hand the task to. See
        // `NappPeriodicSync`.
        NappPeriodicSync.registerHandler()

        // Not a request for permission — that belongs next to the site asking
        // for it, and is `NappPush.requestPermission`. This only picks the token
        // back up for somebody who has already said yes, since the token can
        // change between launches and the push service has to be told.
        NappNotifications.refresh { granted in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }

        return true
    }

    // MARK: - The token

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NSLog("[Tenna] APNs token registered (%@)", NappTokens.environment)
        NappTokens.resolve(hex)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[Tenna] APNs registration failed: %@", error.localizedDescription)
        // Answered rather than left hanging: a web layer awaiting a token it is
        // never going to get would simply never register with the push service
        // and never say why.
        NappTokens.resolve(nil)
    }

    // MARK: - Notifications

    /**
     A push that arrived while Tenna is on screen.

     Shown anyway. A notification is about a site the user is not looking at —
     they are looking at Tenna, or at some other site — so suppressing it would
     be hiding the one case where the answer is definitely wanted now. The
     extension has already run the site's worker either way.
     */
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let site = notification.request.content.threadIdentifier
        if !site.isEmpty { NappPushPlugin.current?.delivered(siteId: site) }
        completionHandler([.banner, .list, .sound])
    }

    /**
     A tap, which opens the site where the notification pointed.

     `data.url` is a convention rather than anything the standard says, but it
     is what every push service worker on Nostr already writes and the only
     thing that can route a tap with no worker alive to route it — the same
     reading Android takes. See NAPP.md.

     There is no `notificationclick` in the worker to follow it with. Running
     one takes a `UNNotificationServiceExtension`, and iOS starts one of those
     only to mutate an arriving push; a tap gets the app instead. So a site that
     does its routing in the worker gets its front page here, and one that
     declares `data.url` gets the page it named.
     */
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let site = info["site"] as? String
            ?? response.notification.request.content.threadIdentifier

        if NsiteOrigins.isSiteId(site) {
            let path = (info["url"] as? String).flatMap {
                $0.hasPrefix("/") && !$0.hasPrefix("//") ? $0 : nil
            }
            NappPushPlugin.current?.opened(siteId: site, path: path)
        }

        completionHandler()
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // The user may have been to Settings while we were away, and what they
        // decided there is half of what `Notification.permission` reads.
        NappNotifications.refresh()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
