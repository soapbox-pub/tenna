import BackgroundTasks
import Foundation

/**
 `registration.periodicSync`, run from a background refresh task.

 The iOS counterpart of `NappPeriodicSync.java` and its worker, and a much
 weaker promise. Android hands the schedule to WorkManager and it runs when it
 said it would. Here there is one `BGAppRefreshTask` for the whole app, and iOS
 decides when it runs — by how often the user opens Tenna, the battery, the
 time of day — and never runs it at all once the user has swiped Tenna away in
 the app switcher. `earliestBeginDate` is a floor, not an appointment. So a
 site's `minInterval` is a request the system is free to honour hours late,
 and NAPP.md says so.

 A run gets about thirty seconds for everything. It wakes each site with a tag
 that is due, one after the other, through the same `NsiteWorkerHost` the
 notification extension uses — compiled into this target too — and posts what
 the worker asks to show with `UNUserNotificationCenter.add`, for a site the
 user has let notify. See `NappNotifyGrants`.
 */
enum NappPeriodicSync {

    static let identifier = "pub.soapbox.tenna.periodicsync"

    /// The whole run, short of the thirty seconds or so iOS gives a refresh
    /// task, so the last worker is stopped by us and not by the watchdog.
    private static let budget: TimeInterval = 25

    // MARK: - Registering

    /// Register or re-register a tag, and ask for a run. See `NsitePeriodic`.
    static func register(siteId: String, label: String?, tag: String, minInterval: TimeInterval) throws {
        try NsitePeriodic.register(siteId: siteId, label: label, tag: tag, minInterval: minInterval)
        schedule()
    }

    static func unregister(siteId: String, tag: String) {
        NsitePeriodic.unregister(siteId: siteId, tag: tag)
        schedule()
    }

    static func forget(siteId: String) {
        guard let record = NsiteStore.load(siteId), !record.periodicSync.isEmpty else { return }
        NsiteStore.update(siteId) { $0.periodicSync = [] }
        schedule()
    }

    static func tags(siteId: String) -> [String] {
        NsitePeriodic.tags(siteId: siteId)
    }

    // MARK: - When

    /// A little early counts, as on Android: a quarter of the tag's interval,
    /// never more than five minutes.
    private static func slack(_ tag: NsitePeriodicTag) -> TimeInterval {
        min(tag.minInterval / 4, 5 * 60)
    }

    static func due(_ tags: [NsitePeriodicTag], at now: TimeInterval) -> [String] {
        tags.filter { now - $0.lastRun >= $0.minInterval - slack($0) }.map(\.tag)
    }

    /// When the soonest tag of any site comes due, or nil if nothing is registered.
    private static func nextDue() -> Date? {
        let soonest = NsiteStore.all()
            .flatMap(\.periodicSync)
            .map { $0.lastRun + $0.minInterval - slack($0) }
            .min()
        return soonest.map { Date(timeIntervalSince1970: $0) }
    }

    // MARK: - The task

    /// Must be called before the app finishes launching, or iOS will not hand
    /// the task to anybody.
    static func registerHandler() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
    }

    /**
     Ask for the next run, at the soonest time anything will be due.

     Called whenever a tag changes, when the app goes to the background, and at
     the start of every run. A request replaces the last one with the same
     identifier, so this is safe to call as often as anything likes.
     */
    static func schedule() {
        guard let next = nextDue() else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
            return
        }

        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = max(next, Date())
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // The simulator, or background refresh turned off in Settings.
            NSLog("[NappPeriodicSync] could not schedule: %@", error.localizedDescription)
        }
    }

    private static func handle(_ task: BGAppRefreshTask) {
        // The next one first, as Apple asks: a run that is killed part way
        // through must not leave nothing scheduled behind it.
        schedule()

        let completion = Completion(task)
        let work = Task { @MainActor in
            await run(deadline: Date().addingTimeInterval(budget))
            // Back to suspended next, and holding no lock in the App Group.
            NsiteIndexedDB.closeIdle()
            completion.finish(success: true)
        }
        task.expirationHandler = {
            work.cancel()
            completion.finish(success: false)
        }
    }

    /// `setTaskCompleted` exactly once, whichever of the run or the expiry gets there first.
    private final class Completion: @unchecked Sendable {
        private let task: BGAppRefreshTask
        private let lock = NSLock()
        private var done = false

        init(_ task: BGAppRefreshTask) { self.task = task }

        func finish(success: Bool) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { task.setTaskCompleted(success: success) }
        }
    }

    /**
     Wake every site that has a tag due, in turn, until the time runs out.

     Oldest record first, so a site that registered late cannot starve the ones
     before it. The last run is written down before a worker is started, so one
     that hangs until the task is killed is not the first thing woken next time.
     */
    @MainActor
    static func run(deadline: Date) async {
        let now = Date().timeIntervalSince1970
        let sites = NsiteStore.all()
            .filter { !$0.periodicSync.isEmpty }
            .sorted { $0.updatedAt < $1.updatedAt }

        for site in sites {
            guard !Task.isCancelled else { return }
            let left = deadline.timeIntervalSinceNow
            guard left > 2 else { return }

            let due = due(site.periodicSync, at: now)
            guard !due.isEmpty, site.files[site.worker ?? "/sw.js"] != nil else { continue }

            NsiteStore.update(site.siteId) { record in
                for index in record.periodicSync.indices where due.contains(record.periodicSync[index].tag) {
                    record.periodicSync[index].lastRun = now
                }
            }

            let host = NsiteWorkerHost(site: site)

            for tag in due {
                let left = deadline.timeIntervalSinceNow
                guard !Task.isCancelled, left > 2 else { return }

                NSLog("[NappPeriodicSync] waking %@ for %@", site.siteId, tag)
                let notifications = await host.deliver(kind: "periodicsync", data: tag, timeout: left)
                await post(notifications, for: site)
            }
        }
    }

    /// What a worker asked to show, for a site that may.
    @MainActor
    private static func post(_ notifications: [NsiteWorkerHost.Notification], for site: NsiteRecord) async {
        guard !notifications.isEmpty else { return }
        guard NappNotifyGrants.allowed(site.siteId), !(NsiteStore.load(site.siteId)?.muted ?? false) else {
            NSLog("[NappPeriodicSync] %@ may not notify; dropped %d", site.siteId, notifications.count)
            return
        }

        for notification in notifications {
            _ = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                NappNotifications.show(
                    siteId: site.siteId,
                    label: site.label,
                    title: notification.title,
                    options: notification.options
                ) { continuation.resume(returning: $0) }
            }
        }
        NappPushPlugin.current?.delivered(siteId: site.siteId)
    }
}

/**
 Which sites the user has let send notifications, as the native side sees it.

 The grant lives in the web layer's `localStorage`, where nothing native can
 read it, and is mirrored here by `NsiteGrants` on every change and at every
 launch. What reads it is a periodic sync run: unlike a push, being woken by
 one is no proof the site was ever allowed to say anything. A site with
 subscriptions counts too, because the web layer asks before it sets them.

 Only the main app reads this, so it is kept in the app's own defaults rather
 than in the shared container.
 */
enum NappNotifyGrants {

    private static let key = "napp-notify-grants"

    static func set(_ siteIds: [String]) {
        UserDefaults.standard.set(siteIds, forKey: key)
    }

    static func allowed(_ siteId: String) -> Bool {
        if (UserDefaults.standard.stringArray(forKey: key) ?? []).contains(siteId) { return true }
        return !(NsiteStore.load(siteId)?.subscriptions.isEmpty ?? true)
    }
}
