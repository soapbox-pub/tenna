import CryptoKit
import Foundation
import SQLite3

/**
 The store behind a site's IndexedDB: a directory per site in the App Group,
 and in it a SQLite file per database.

 A site's page, the page's frames and workers, and the copy of its service
 worker the notification extension runs all see one IndexedDB, because none of
 them keeps it: the engine injected into each (`NsiteIndexedDB.js`, built from
 `src/lib/idb`) does everything IndexedDB decides in script and sends only the
 record-keeping here, over the protocol in `src/lib/idb/protocol.ts`. This file
 answers that protocol exactly as `memoryStore.ts` does, which is what the
 conformance tests run against.

 **Strings stay UTF-16.** Keys, values and names arrive as JavaScript strings
 and are kept as their code units — lone surrogates and NULs included — and
 never pass through a Swift `String`, which would repair them. Keys are stored
 as big-endian units so SQLite's `memcmp` blob order is IndexedDB's key order;
 values and names as they came.

 **One writer a database.** A readwrite or upgrade transaction holds its
 database's writer connection from its first message to its last, and
 `BEGIN IMMEDIATE` makes the other process wait for it too. A readonly
 transaction takes a connection of its own and reads the snapshot WAL gives it
 at begin. A file a database, rather than one a site, because IndexedDB lets
 transactions on different databases run side by side and SQLite has one
 writer a file.

 **Deleting** a database empties its file, and removes the file only once
 nothing else has it open — another process may, and a file unlinked under an
 open connection is one that connection goes on using, unseen. SQLite says
 whether anyone does: an exclusive lock is only granted to the only
 connection. A file that was still open when its database went is removed
 the next time `databases()` comes across it empty.

 **Suspension.** iOS kills a suspended app holding a lock on a file in an App
 Group. The app ends transactions quickly anyway; `activity` tells it when any
 are open so it can hold a background task, and `closeIdle` lets it drop every
 connection on its way into the background.
 */
final class NsiteIndexedDB {

    // MARK: - Sites

    /// Where a site's database files live.
    static var location: (String) -> URL = { siteId in
        NsiteGroup.directory("nsite-idb").appendingPathComponent(siteId, isDirectory: true)
    }

    /// Called on the main thread with true when a transaction opens with none
    /// open before, and false when the last one ends.
    static var activity: ((Bool) -> Void)?

    private static var sites: [String: NsiteIndexedDB] = [:]
    private static var open = 0

    /// The store for a site, opened on first use. Main thread.
    static func site(_ siteId: String) -> NsiteIndexedDB {
        if let site = sites[siteId] { return site }
        let site = NsiteIndexedDB(directory: location(siteId))
        sites[siteId] = site
        listenForChanges()
        return site
    }

    /// Close every connection no transaction is using. Main thread.
    static func closeIdle() {
        for site in sites.values { site.closeIdle() }
    }

    /**
     Delete a site's database. Main thread. Any open transaction is aborted
     first; a store another process has open keeps its file until it closes.
     */
    static func forget(_ siteId: String) {
        if let site = sites.removeValue(forKey: siteId) { site.shutDown() }
        try? FileManager.default.removeItem(at: location(siteId))
    }

    // MARK: - Changes across processes

    private static let changed = "pub.soapbox.tenna.idb.changed" as CFString
    private static var listening = false

    /// Hear of upgrades and deletions another process commits.
    private static func listenForChanges() {
        guard !listening else { return }
        listening = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in
                DispatchQueue.main.async {
                    for site in NsiteIndexedDB.sites.values { site.checkWaits() }
                }
            },
            changed, nil, .deliverImmediately)
    }

    private static func announce() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(changed), nil, nil, true)
    }

    // MARK: - State

    private let directory: URL
    private let filesLock = NSLock()
    private var files: [String: IDBFile] = [:]
    private let reads = DispatchQueue(label: "pub.soapbox.tenna.idb.reads", qos: .userInitiated, attributes: .concurrent)

    // Main thread only.
    private var transactions: [String: IDBTransaction] = [:]
    /// What `databases()` last read from each file, and the modification
    /// times of the file and its WAL then: any commit, in any process, moves
    /// one or the other, so while both stand the rows do too.
    private var listed: [String: (stamp: [Int], rows: [IDBWire])] = [:]
    private var waits: [String: IDBWait] = [:]
    private var closed = false

    init(directory: URL) {
        self.directory = directory
    }

    /// The file a database lives in, named for the SHA-256 of its name's units.
    private func file(for name: ArraySlice<UInt16>) -> IDBFile {
        file(named: hex(name))
    }

    /// The database's file if there is one: only an upgrade makes one.
    private func existingFile(for name: ArraySlice<UInt16>) -> IDBFile? {
        let hex = hex(name)
        let path = directory.appendingPathComponent("\(hex).sqlite").path
        return FileManager.default.fileExists(atPath: path) ? file(named: hex) : nil
    }

    /**
     Remove a database's file if it holds no database and nobody has it open.
     Main thread. A transaction here — which holds the writer or a reader —
     or a connection in another process keeps it.
     */
    private func remove(_ hex: String, _ file: IDBFile) {
        // The file's object stays: it is the one lock there is for its path,
        // and a transaction may already hold it to make the file again.
        _ = file.removeIfUnused()
    }

    private func hex(_ name: ArraySlice<UInt16>) -> String {
        let digest = name.withUnsafeBytes { SHA256.hash(data: $0) }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// How many databases may have connections open at once. A connection
    /// is three descriptors — the file, its WAL, its shared memory — and a
    /// site can have any number of databases; iOS allows a process a few
    /// hundred descriptors in all.
    private static let openFiles = 8

    private func file(named hex: String) -> IDBFile {
        filesLock.lock()
        defer { filesLock.unlock() }
        let file: IDBFile
        if let known = files[hex] {
            file = known
        } else {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            file = IDBFile(path: directory.appendingPathComponent("\(hex).sqlite").path)
            files[hex] = file
        }
        file.touch()
        // Close what has gone longest unused, when too much is open. A file
        // a transaction is using keeps what it is using.
        let open = files.values.filter { $0 !== file && $0.isOpen }
        if open.count >= Self.openFiles {
            for idle in open.sorted(by: { $0.lastUsed < $1.lastUsed }).prefix(open.count - Self.openFiles + 1) {
                idle.closeIdle()
            }
        }
        return file
    }

    /// A file's modification time, to the nanosecond, or zeros if it is not there.
    private static func stamp(_ path: String) -> [Int] {
        var info = stat()
        guard stat(path, &info) == 0 else { return [0, 0] }
        return [Int(info.st_mtimespec.tv_sec), Int(info.st_mtimespec.tv_nsec)]
    }

    /// The name of every database file there is, whoever made it.
    private func allFiles() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".sqlite") }.map { String($0.dropLast(".sqlite".count)) }
    }

    // MARK: - Messages

    /**
     Answer one message. Main thread; `reply` is called on the main thread
     with the answer's code units, or with an error message.
     */
    func receive(_ units: [UInt16], from channel: NsiteIndexedDBChannel, reply: @escaping (Result<[UInt16], IDBFailure>) -> Void) {
        let message: [IDBWire]
        do {
            var parser = IDBWireParser(units)
            guard case let .list(list) = try parser.parse() else { throw IDBFailure.corrupt }
            message = list
        } catch {
            reply(.failure(error as? IDBFailure ?? .corrupt))
            return
        }
        guard !closed, let command = message.first?.ascii else {
            reply(.failure(IDBFailure("UnknownError", closed ? "The store has closed." : "No command.")))
            return
        }
        let answer: (Result<IDBWire, IDBFailure>) -> Void = { result in
            DispatchQueue.main.async { reply(result.map { $0.encoded }) }
        }

        switch command {
        case "databases":
            // Read as the message arrives, not on a queue: a commit sent just
            // after it must not be what it reports.
            answer(databases())
        case "schema":
            guard let name = message[safe: 1]?.units else { return reply(.failure(.corrupt)) }
            reads.async {
                guard let file = self.existingFile(for: name) else { return answer(.success(.null)) }
                answer(file.withReader { conn in try self.schema(named: name, on: conn).map { $0.wire } ?? .null })
            }
        case "drop":
            guard let name = message[safe: 2]?.units else { return reply(.failure(.corrupt)) }
            DispatchQueue.global(qos: .userInitiated).async { answer(self.drop(name)) }
        case "tx":
            guard let realm = message[safe: 1]?.ascii, let id = message[safe: 2]?.ascii,
                  let ops = message[safe: 4]?.list else { return reply(.failure(.corrupt)) }
            channel.realms.insert(realm)
            if let ends = message[safe: 5]?.list { endReads(realm, ends) }
            transaction(realm: realm, id: id, begin: message[safe: 3]?.list, ops: ops, reply: answer)
        case "end":
            guard let realm = message[safe: 1]?.ascii, let ends = message[safe: 2]?.list else { return reply(.failure(.corrupt)) }
            endReads(realm, ends)
            reply(.success(IDBWire.number(0).encoded))
        case "wait":
            guard let realm = message[safe: 1]?.ascii, let open = message[safe: 2]?.list else { return reply(.failure(.corrupt)) }
            channel.realms.insert(realm)
            wait(realm: realm, open: open, reply: answer)
        case "bye":
            if let realm = message[safe: 1]?.ascii { bye(realm) }
            reply(.success(IDBWire.number(0).encoded))
        default:
            reply(.failure(IDBFailure("UnknownError", "Unknown command \(command).")))
        }
    }

    /// A channel is going away: everything its realms had open ends. Main thread.
    func close(_ channel: NsiteIndexedDBChannel) {
        for realm in channel.realms { bye(realm) }
        channel.realms.removeAll()
    }

    /// End readonly transactions, each in its turn after what it already had.
    private func endReads(_ realm: String, _ ids: [IDBWire]) {
        for id in ids.compactMap(\.ascii) {
            transaction(realm: realm, id: id, begin: nil, ops: [.list([.string(ArraySlice("commit".utf16))])]) { _ in }
        }
    }

    private func bye(_ realm: String) {
        for (key, txn) in transactions where txn.realm == realm {
            transactions.removeValue(forKey: key)
            txn.queue.async { self.end(txn, commit: false) }
        }
        if let wait = waits.removeValue(forKey: realm) { wait.reply(.success(.list([]))) }
    }

    private func shutDown() {
        closed = true
        for txn in transactions.values { txn.queue.async { self.end(txn, commit: false) } }
        transactions.removeAll()
        for wait in waits.values { wait.reply(.success(.list([]))) }
        waits.removeAll()
        closeIdle()
    }

    private func closeIdle() {
        filesLock.lock()
        let all = Array(files.values)
        filesLock.unlock()
        for file in all { file.closeIdle() }
    }

    // MARK: - Databases

    private func databases() -> Result<IDBWire, IDBFailure> {
        var out: [IDBWire] = []
        // One at a time, each through `file(named:)`, so no more are open at
        // once than it allows however many databases the site has made.
        for hex in allFiles() {
            let path = directory.appendingPathComponent("\(hex).sqlite").path
            let stamp = Self.stamp(path) + Self.stamp(path + "-wal")
            if let known = listed[hex], known.stamp == stamp {
                out.append(contentsOf: known.rows)
                continue
            }
            let file = file(named: hex)
            let found = file.withReader { conn -> IDBWire in
                let st = try conn.statement("SELECT name, version FROM databases")
                var rows: [IDBWire] = []
                while try st.step() {
                    rows.append(.list([.string(ArraySlice(st.units(0))), .number(Double(st.int(1)))]))
                }
                return .list(rows)
            }
            // A file with no schema yet — made by an upgrade that never got
            // that far — holds no database, and neither does an emptied one.
            if case let .success(.list(rows)) = found, !rows.isEmpty {
                out.append(contentsOf: rows)
                listed[hex] = (stamp, rows)
            } else {
                listed.removeValue(forKey: hex)
                remove(hex, file)
            }
        }
        return .success(.list(out))
    }

    private func schema(named name: ArraySlice<UInt16>, on conn: IDBConnection) throws -> IDBSchemaRow? {
        let st = try conn.statement("SELECT id, version, incarnation FROM databases WHERE name = ?")
        st.bind(1, units: name)
        guard try st.step() else { return nil }
        let (id, version, incarnation) = (st.int(0), st.int(1), st.text(2))
        st.reset()
        return try schema(id: id, version: version, incarnation: incarnation, on: conn)
    }

    private func schema(id: Int64, version: Int64, incarnation: String, on conn: IDBConnection) throws -> IDBSchemaRow {
        var indexes: [Int64: [IDBWire]] = [:]
        let ix = try conn.statement("SELECT id, store, name, key_path, is_unique, multi_entry FROM indexes WHERE db = ? ORDER BY id")
        ix.bind(1, int: id)
        while try ix.step() {
            indexes[ix.int(1), default: []].append(.list([
                .number(Double(ix.int(0))), .string(ArraySlice(ix.units(2))), .string(ArraySlice(ix.units(3))),
                .number(Double(ix.int(4))), .number(Double(ix.int(5))),
            ]))
        }
        var stores: [IDBWire] = []
        let st = try conn.statement("SELECT id, name, key_path, auto_increment FROM stores WHERE db = ? ORDER BY id")
        st.bind(1, int: id)
        while try st.step() {
            let storeId = st.int(0)
            stores.append(.list([
                .number(Double(storeId)), .string(ArraySlice(st.units(1))),
                st.isNull(2) ? .null : .string(ArraySlice(st.units(2))),
                .number(Double(st.int(3))), .list(indexes[storeId] ?? []),
            ]))
        }
        return IDBSchemaRow(id: id, version: version, incarnation: incarnation, stores: stores)
    }

    private func drop(_ name: ArraySlice<UInt16>) -> Result<IDBWire, IDBFailure> {
        guard let file = existingFile(for: name) else { return .success(.number(0)) }
        file.writerLock.wait()
        defer { file.writerLock.signal() }
        do {
            let conn = try file.writer()
            try conn.exec("BEGIN IMMEDIATE")
            do {
                let find = try conn.statement("SELECT id, version FROM databases WHERE name = ?")
                find.bind(1, units: name)
                guard try find.step() else {
                    find.reset()
                    try conn.exec("COMMIT")
                    return .success(.number(0))
                }
                let (id, version) = (find.int(0), find.int(1))
                find.reset()
                for sql in [
                    "DELETE FROM entries WHERE db = ?", "DELETE FROM records WHERE db = ?",
                    "DELETE FROM indexes WHERE db = ?", "DELETE FROM stores WHERE db = ?",
                    "DELETE FROM databases WHERE id = ?",
                ] {
                    let st = try conn.statement(sql)
                    st.bind(1, int: id)
                    try st.run()
                }
                try conn.exec("COMMIT")
                DispatchQueue.main.async {
                    self.changed()
                    self.remove(self.hex(name), file)
                }
                return .success(.number(Double(version)))
            } catch {
                try? conn.exec("ROLLBACK")
                throw error
            }
        } catch {
            return .failure(IDBFailure.from(error))
        }
    }

    // MARK: - Waiting for other realms' changes

    private func wait(realm: String, open: [IDBWire], reply: @escaping (Result<IDBWire, IDBFailure>) -> Void) {
        if let before = waits.removeValue(forKey: realm) { before.reply(.success(.list([]))) }
        let wait = IDBWait(open: open.compactMap { item -> IDBWait.Entry? in
            guard let list = item.list, let name = list[safe: 0]?.units, let version = list[safe: 1]?.number,
                  let incarnation = list[safe: 2]?.ascii else { return nil }
            return IDBWait.Entry(name: name, version: version, incarnation: incarnation)
        }, reply: reply)
        waits[realm] = wait
        check(realm: realm, wait)
    }

    /// Something committed here or in another process. Main thread.
    private func changed() {
        checkWaits()
        Self.announce()
    }

    fileprivate func checkWaits() {
        for (realm, wait) in waits { check(realm: realm, wait) }
    }

    private func check(realm: String, _ wait: IDBWait) {
        reads.async {
            var out: [IDBWire] = []
            var failed = false
            for entry in wait.open {
                guard let file = self.existingFile(for: entry.name) else {
                    out.append(.list([.string(entry.name), .number(0), .string(ArraySlice())]))
                    continue
                }
                let found = file.withReader { conn -> IDBWire in
                    let st = try conn.statement("SELECT version, incarnation FROM databases WHERE name = ?")
                    st.bind(1, units: entry.name)
                    var (version, incarnation) = (0.0, "")
                    if try st.step() { (version, incarnation) = (Double(st.int(0)), st.text(1)) }
                    st.reset()
                    if version != entry.version || incarnation != entry.incarnation {
                        return .list([.string(entry.name), .number(version), .string(ArraySlice(incarnation.utf16))])
                    }
                    return .null
                }
                switch found {
                case let .success(item): if case .list = item { out.append(item) }
                case .failure: failed = true
                }
            }
            let found: Result<IDBWire, IDBFailure> = failed ? .failure(.corrupt) : .success(.list(out))
            DispatchQueue.main.async {
                guard self.waits[realm] === wait, case let .success(.list(list)) = found, !list.isEmpty else { return }
                self.waits.removeValue(forKey: realm)
                wait.reply(.success(.list(list)))
            }
        }
    }

    // MARK: - Transactions

    private func transaction(realm: String, id: String, begin: [IDBWire]?, ops: [IDBWire], reply: @escaping (Result<IDBWire, IDBFailure>) -> Void) {
        let key = realm + "\u{0}" + id
        let txn: IDBTransaction
        if let existing = transactions[key] {
            txn = existing
        } else {
            guard begin != nil else {
                reply(.failure(IDBFailure("UnknownError", "Transaction \(id) has not begun.")))
                return
            }
            // Readonly transactions on one database share a queue: they take
            // no locks, so none waits on another, and the order they were
            // made in is the order they are answered in.
            var queue: DispatchQueue?
            if let begin, begin[safe: 0]?.ascii == "r", let name = begin[safe: 1]?.units {
                queue = existingFile(for: name)?.readQueue
            }
            txn = IDBTransaction(realm: realm, id: id, queue: queue)
            transactions[key] = txn
            if Self.open == 0 { Self.activity?(true) }
            Self.open += 1
        }
        let work = {
            var results: [IDBWire] = []
            results.append(begin.map { self.begin(txn, $0) } ?? .null)
            for op in ops {
                if txn.ended || txn.dead {
                    results.append(.null)
                } else {
                    results.append(self.run(txn, op.list ?? []))
                }
            }
            return results
        }
        let finish = { (results: [IDBWire]) in
            let ended = txn.ended || txn.dead
            if ended, self.transactions[key] === txn {
                self.transactions.removeValue(forKey: key)
            }
            if ended, !txn.counted {
                txn.counted = true
                Self.open -= 1
                if Self.open == 0 { Self.activity?(false) }
            }
            if ended, txn.upgraded { self.changed() }
            reply(.success(.list(results)))
        }

        // A small read, with nothing queued ahead of it on its database, is
        // answered here and now: a point read is microseconds, and the two
        // thread hops a queue costs are most of what a small transaction
        // waits on. Order holds, because nothing is queued to overtake.
        let queue = txn.queue
        let reading = begin?[safe: 0]?.ascii.map { $0 == "r" } ?? (txn.mode == "r")
        if reading, (pending[ObjectIdentifier(queue)] ?? 0) == 0, ops.allSatisfy(Self.small) {
            finish(work())
            return
        }
        pending[ObjectIdentifier(queue), default: 0] += 1
        queue.async {
            let results = work()
            DispatchQueue.main.async {
                self.pending[ObjectIdentifier(queue), default: 1] -= 1
                finish(results)
            }
        }
    }

    /// Work queued and not yet answered, by queue. Main thread.
    private var pending: [ObjectIdentifier: Int] = [:]

    /// A read op cheap enough to answer on the main thread.
    private static func small(_ op: IDBWire) -> Bool {
        guard let list = op.list, let name = list.first?.ascii else { return false }
        switch name {
        case "commit", "abort": return true
        case "get": return list[safe: 6]?.ascii != "c" && (1 ... 64).contains(list[safe: 4]?.number ?? 0)
        case "iter": return (1 ... 64).contains(list[safe: 7]?.number ?? 0)
        default: return false
        }
    }

    /// The first message of a transaction: take a connection and begin.
    private func begin(_ txn: IDBTransaction, _ spec: [IDBWire]) -> IDBWire {
        guard let mode = spec[safe: 0]?.ascii, let name = spec[safe: 1]?.units else {
            txn.dead = true
            return .list([.string(ArraySlice("!".utf16)), .string(ArraySlice("UnknownError".utf16))])
        }
        txn.mode = mode
        guard let file = mode == "v" ? file(for: name) : existingFile(for: name) else {
            txn.dead = true
            return .string(ArraySlice("stale".utf16))
        }
        txn.file = file
        do {
            if mode == "r" {
                let conn = try file.acquireReader()
                txn.conn = conn
                txn.reader = true
                try conn.exec("BEGIN")
            } else {
                file.writerLock.wait()
                txn.writer = true
                let conn = try file.writer()
                txn.conn = conn
                try conn.exec("BEGIN IMMEDIATE")
            }
            let conn = txn.conn!
            let find = try conn.statement("SELECT id, version, incarnation FROM databases WHERE name = ?")
            find.bind(1, units: name)
            let row: (Int64, Int64, String)? = try find.step() ? (find.int(0), find.int(1), find.text(2)) : nil
            find.reset()

            if mode == "r" || mode == "w" {
                guard let row, let version = spec[safe: 2]?.number, let incarnation = spec[safe: 3]?.ascii,
                      Double(row.1) == version, row.2 == incarnation else {
                    end(txn, commit: false)
                    txn.dead = true
                    return .string(ArraySlice("stale".utf16))
                }
                txn.db = row.0
                return .string(ArraySlice("ok".utf16))
            }

            // An upgrade.
            let target = Int64(spec[safe: 2]?.number ?? 0)
            if let row, row.1 >= target {
                let schema = try self.schema(id: row.0, version: row.1, incarnation: row.2, on: conn)
                end(txn, commit: false)
                txn.dead = true
                return .list([.string(ArraySlice("skip".utf16)), schema.wire])
            }
            let id: Int64
            let before: IDBSchemaRow
            if let row {
                id = row.0
                before = try self.schema(id: row.0, version: row.1, incarnation: row.2, on: conn)
            } else {
                let incarnation = UUID().uuidString
                let insert = try conn.statement("INSERT INTO databases (name, version, incarnation) VALUES (?, 0, ?)")
                insert.bind(1, units: name)
                insert.bind(2, text: incarnation)
                try insert.run()
                id = conn.lastInsertRowId
                before = IDBSchemaRow(id: id, version: 0, incarnation: incarnation, stores: [])
            }
            let update = try conn.statement("UPDATE databases SET version = ? WHERE id = ?")
            update.bind(1, int: target)
            update.bind(2, int: id)
            try update.run()
            txn.db = id
            return before.wire
        } catch {
            end(txn, commit: false)
            txn.dead = true
            let failure = IDBFailure.from(error)
            return .list([.string(ArraySlice("!".utf16)), .string(ArraySlice(failure.name.utf16)), .string(ArraySlice(failure.message.utf16))])
        }
    }

    /**
     Commit or roll back, and give the connection back. A commit that fails —
     a full disk — rolls back instead, and says why.
     */
    @discardableResult
    private func end(_ txn: IDBTransaction, commit: Bool) -> IDBFailure? {
        guard !txn.ended else { return nil }
        txn.ended = true
        var failure: IDBFailure?
        if let conn = txn.conn {
            conn.resetAll()
            if commit {
                do {
                    for (store, generator) in txn.generators where generator.dirty {
                        let bump = try conn.statement("UPDATE stores SET generator = ? WHERE db = ? AND id = ?")
                        bump.bind(1, int: generator.value)
                        bump.bind(2, int: txn.db)
                        bump.bind(3, int: store)
                        try bump.run()
                    }
                    try conn.exec("COMMIT")
                    if txn.mode == "v" { txn.upgraded = true }
                } catch {
                    failure = IDBFailure.from(error)
                    try? conn.exec("ROLLBACK")
                }
            } else {
                try? conn.exec("ROLLBACK")
            }
            if txn.reader { txn.file?.releaseReader(conn) }
        }
        txn.conn = nil
        if txn.writer {
            txn.writer = false
            txn.file?.writerLock.signal()
        }
        return failure
    }

    private func run(_ txn: IDBTransaction, _ op: [IDBWire]) -> IDBWire {
        if let failed = txn.failed { return failed.wire }
        guard let name = op.first?.ascii, let conn = txn.conn else { return IDBFailure.corrupt.wire }
        do {
            switch name {
            case "commit":
                return end(txn, commit: true)?.wire ?? .number(0)
            case "abort":
                end(txn, commit: false)
                return .number(0)
            default:
                return try IDBOps(conn: conn, txn: txn).run(name, op)
            }
        } catch let failure as IDBFailure {
            return failure.wire
        } catch {
            // SQLite itself failed mid-transaction: nothing after this can be
            // trusted to have happened, so nothing after this happens.
            let failure = IDBFailure.from(error)
            txn.failed = failure
            return failure.wire
        }
    }
}

/// One database's file: its writer, and the readers it lends out.
private final class IDBFile {
    let path: String
    let writerLock = DispatchSemaphore(value: 1)
    /// Used only while holding `writerLock`.
    private var writerConnection: IDBConnection?
    private let readersLock = NSLock()
    private var readers: [IDBConnection] = []
    private var schemaReady = false
    /// Where readonly transactions on this database run, in order.
    let readQueue = DispatchQueue(label: "pub.soapbox.tenna.idb.read", qos: .userInitiated)
    /// Guarded by the site's `filesLock`.
    private(set) var lastUsed: UInt64 = 0
    private static var clock: UInt64 = 0

    init(path: String) {
        self.path = path
    }

    /// Mark as just used. Under the site's `filesLock`.
    func touch() {
        Self.clock &+= 1
        lastUsed = Self.clock
    }

    /// Whether any connection to the file is open, idle or not.
    var isOpen: Bool {
        readersLock.lock()
        defer { readersLock.unlock() }
        return !readers.isEmpty || writerConnection != nil || lent > 0
    }

    /// Readers out with a transaction.
    private var lent = 0

    /// The writer, opened and the schema made on first use. Hold `writerLock`.
    func writer() throws -> IDBConnection {
        if let conn = writerConnection { return conn }
        let conn = try IDBConnection(path: path)
        if !schemaReady {
            try check(conn)
            try conn.exec(IDBSchema.create)
            try conn.exec("PRAGMA user_version = \(IDBSchema.version)")
            schemaReady = true
        }
        writerConnection = conn
        return conn
    }

    /// Refuse a file a newer build made. One with no version yet is new.
    private func check(_ conn: IDBConnection) throws {
        let st = try conn.statement("PRAGMA user_version")
        defer { st.reset() }
        let version = try st.step() ? st.int(0) : 0
        if version > IDBSchema.version {
            throw IDBFailure("UnknownError", "This database was written by a newer Tenna (layout \(version)).")
        }
    }

    func acquireReader() throws -> IDBConnection {
        readersLock.lock()
        lent += 1
        if let conn = readers.popLast() {
            readersLock.unlock()
            return conn
        }
        readersLock.unlock()
        do {
            // A file with no schema yet has nothing to read, and a read of it
            // fails with no such table, which each reader takes as "none".
            let conn = try IDBConnection(path: path)
            try check(conn)
            return conn
        } catch {
            readersLock.lock()
            lent -= 1
            readersLock.unlock()
            throw error
        }
    }

    func releaseReader(_ conn: IDBConnection) {
        // A statement left on a row keeps its read transaction, and with it
        // a snapshot the next user of this connection would read.
        conn.resetAll()
        readersLock.lock()
        lent -= 1
        // One idle reader is plenty to keep; the rest are closed.
        if readers.isEmpty { readers.append(conn) }
        readersLock.unlock()
    }

    func withReader(_ body: (IDBConnection) throws -> IDBWire) -> Result<IDBWire, IDBFailure> {
        do {
            let conn = try acquireReader()
            defer { releaseReader(conn) }
            return .success(try body(conn))
        } catch {
            return .failure(IDBFailure.from(error))
        }
    }

    func closeIdle() {
        readersLock.lock()
        readers.removeAll()
        readersLock.unlock()
        if writerLock.wait(timeout: .now()) == .success {
            writerConnection = nil
            writerLock.signal()
        }
    }

    /**
     Delete the file, if it holds no database and no connection anywhere has
     it open. True if it was deleted.
     */
    func removeIfUnused() -> Bool {
        guard writerLock.wait(timeout: .now()) == .success else { return false }
        defer { writerLock.signal() }
        readersLock.lock()
        let busy = lent > 0
        if !busy { readers.removeAll() }
        readersLock.unlock()
        guard !busy else { return false }
        writerConnection = nil
        guard FileManager.default.fileExists(atPath: path),
              let conn = try? IDBConnection(path: path, busyTimeout: 0) else { return false }
        do {
            // Exclusive locking only succeeds for the one connection there is.
            try conn.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE")
            let st = try conn.statement("SELECT count(*) FROM databases")
            let count = try st.step() ? st.int(0) : 0
            st.reset()
            guard count == 0 else {
                try? conn.exec("ROLLBACK")
                return false
            }
        } catch let error as IDBSQLiteError where error.message.contains("no such table") {
            // Never given a schema: nothing in it either.
        } catch {
            return false
        }
        for suffix in ["", "-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
        schemaReady = false
        return true
    }
}

// MARK: - The bridge

extension NsiteIndexedDB {
    /// The engine, built from `src/lib/idb` by `npm run idb` and carried as a
    /// resource by the app and the extension alike.
    static let script: String? = Bundle.main.url(forResource: "NsiteIndexedDB", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    /// A message body as its code units, never by way of a Swift `String`,
    /// which would repair a lone surrogate the site meant.
    static func units(of body: Any) -> [UInt16]? {
        guard let string = body as? NSString else { return nil }
        let length = string.length
        var units = [UInt16](repeating: 0, count: length)
        if length > 0 {
            units.withUnsafeMutableBufferPointer { buffer in
                string.getCharacters(buffer.baseAddress!, range: NSRange(location: 0, length: length))
            }
        }
        return units
    }

    /// Code units as a string WebKit hands to script unchanged.
    static func string(_ units: [UInt16]) -> NSString {
        guard !units.isEmpty else { return "" }
        return units.withUnsafeBufferPointer { NSString(characters: $0.baseAddress!, length: units.count) }
    }

    /// Answer a message from a script message handler with a reply.
    func receive(body: Any, from channel: NsiteIndexedDBChannel, reply: @escaping (Any?, String?) -> Void) {
        guard let units = Self.units(of: body) else {
            reply(nil, "UnknownError: The message was not text.")
            return
        }
        receive(units, from: channel) { result in
            switch result {
            case let .success(answer): reply(Self.string(answer), nil)
            case let .failure(failure): reply(nil, "\(failure.name): \(failure.message)")
            }
        }
    }
}

/// What connects one WebView — or worker host — to the store, so that when it
/// goes away, so does everything its realms had open.
final class NsiteIndexedDBChannel {
    fileprivate var realms = Set<String>()
    init() {}
}

// MARK: - Transactions

private final class IDBTransaction {
    let realm: String
    let id: String
    let queue: DispatchQueue
    var mode = "r"
    var file: IDBFile?
    var conn: IDBConnection?
    var db: Int64 = 0
    var writer = false
    var reader = false
    var ended = false
    /// Never began, or began and was found stale or already upgraded.
    var dead = false
    var upgraded = false
    var failed: IDBFailure?
    /// Counted out of `NsiteIndexedDB.open`. Main thread.
    var counted = false
    /// Each store's indexes, `(id, unique)`, as read in this transaction.
    var indexes: [Int64: [(Int64, Bool)]] = [:]
    /// Each store's key generator as this transaction has it: whether it has
    /// one, its current number, and whether that is ahead of the file. The
    /// transaction holds the writer, so nobody else can move it; it goes to
    /// the file once, at commit.
    var generators: [Int64: (auto: Bool, value: Int64, dirty: Bool)] = [:]

    init(realm: String, id: String, queue: DispatchQueue? = nil) {
        self.realm = realm
        self.id = id
        self.queue = queue ?? DispatchQueue(label: "pub.soapbox.tenna.idb.txn", qos: .userInitiated)
    }
}

private final class IDBWait {
    struct Entry {
        let name: ArraySlice<UInt16>
        let version: Double
        let incarnation: String
    }

    let open: [Entry]
    let reply: (Result<IDBWire, IDBFailure>) -> Void

    init(open: [Entry], reply: @escaping (Result<IDBWire, IDBFailure>) -> Void) {
        self.open = open
        self.reply = reply
    }
}

private struct IDBSchemaRow {
    let id: Int64
    let version: Int64
    let incarnation: String
    let stores: [IDBWire]

    var wire: IDBWire {
        .list([.number(Double(version)), .string(ArraySlice(incarnation.utf16)), .list(stores)])
    }
}

// MARK: - Ops

/// The ops of `protocol.ts`, run on a transaction's connection.
private struct IDBOps {
    let conn: IDBConnection
    let txn: IDBTransaction

    var db: Int64 { txn.db }

    func run(_ name: String, _ op: [IDBWire]) throws -> IDBWire {
        switch name {
        case "cs":
            let st = try conn.statement("INSERT INTO stores (db, id, name, key_path, auto_increment, generator) VALUES (?, ?, ?, ?, ?, 1)")
            st.bind(1, int: db)
            st.bind(2, int: try op.int(1))
            st.bind(3, units: try op.units(2))
            if let path = op[safe: 3]?.units { st.bind(4, units: path) } else { st.bindNull(4) }
            st.bind(5, int: try op.int(4))
            try st.run()
            return .number(0)
        case "ds":
            let store = try op.int(1)
            try exec("DELETE FROM entries WHERE db = ?1 AND idx IN (SELECT id FROM indexes WHERE db = ?1 AND store = ?2)", db, store)
            try exec("DELETE FROM indexes WHERE db = ?1 AND store = ?2", db, store)
            try exec("DELETE FROM records WHERE db = ?1 AND store = ?2", db, store)
            try exec("DELETE FROM stores WHERE db = ?1 AND id = ?2", db, store)
            txn.indexes.removeValue(forKey: store)
            txn.generators.removeValue(forKey: store)
            return .number(0)
        case "rs":
            let st = try conn.statement("UPDATE stores SET name = ? WHERE db = ? AND id = ?")
            st.bind(1, units: try op.units(2))
            st.bind(2, int: db)
            st.bind(3, int: try op.int(1))
            try st.run()
            return .number(0)
        case "ci":
            let st = try conn.statement("INSERT INTO indexes (db, id, store, name, key_path, is_unique, multi_entry) VALUES (?, ?, ?, ?, ?, ?, ?)")
            st.bind(1, int: db)
            st.bind(2, int: try op.int(1))
            st.bind(3, int: try op.int(2))
            st.bind(4, units: try op.units(3))
            st.bind(5, units: try op.units(4))
            st.bind(6, int: try op.int(5))
            st.bind(7, int: try op.int(6))
            try st.run()
            txn.indexes.removeValue(forKey: try op.int(2))
            return .number(0)
        case "di":
            let index = try op.int(1)
            try exec("DELETE FROM entries WHERE db = ?1 AND idx = ?2", db, index)
            try exec("DELETE FROM indexes WHERE db = ?1 AND id = ?2", db, index)
            txn.indexes.removeAll()
            return .number(0)
        case "ri":
            let st = try conn.statement("UPDATE indexes SET name = ? WHERE db = ? AND id = ?")
            st.bind(1, units: try op.units(2))
            st.bind(2, int: db)
            st.bind(3, int: try op.int(1))
            try st.run()
            return .number(0)
        case "put":
            return try put(op)
        case "ia":
            return try fill(op)
        case "del":
            let store = try op.int(1)
            let range = try IDBRange(op[safe: 2])
            var args: [IDBBinding] = [.int(db), .int(store)]
            let condition = range.sql(column: "key", args: &args)
            try exec("DELETE FROM entries WHERE db = ?1 AND idx IN (SELECT id FROM indexes WHERE db = ?1 AND store = ?2) AND pk IN (SELECT key FROM records WHERE db = ?1 AND store = ?2\(condition))", args)
            try exec("DELETE FROM records WHERE db = ?1 AND store = ?2\(condition)", args)
            return .number(0)
        case "clr":
            let store = try op.int(1)
            try exec("DELETE FROM entries WHERE db = ?1 AND idx IN (SELECT id FROM indexes WHERE db = ?1 AND store = ?2)", db, store)
            try exec("DELETE FROM records WHERE db = ?1 AND store = ?2", db, store)
            return .number(0)
        case "get":
            return try get(op)
        case "iter":
            return try iterate(op)
        default:
            throw IDBFailure("UnknownError", "Unknown op \(name).")
        }
    }

    private func exec(_ sql: String, _ ints: Int64...) throws {
        try exec(sql, ints.map { .int($0) })
    }

    private func exec(_ sql: String, _ args: [IDBBinding]) throws {
        let st = try conn.statement(sql)
        for (i, arg) in args.enumerated() { st.bind(Int32(i + 1), arg) }
        try st.run()
    }

    /// A store's indexes, `(id, unique)`.
    private func indexes(of store: Int64) throws -> [(Int64, Bool)] {
        if let known = txn.indexes[store] { return known }
        let st = try conn.statement("SELECT id, is_unique FROM indexes WHERE db = ? AND store = ?")
        st.bind(1, int: db)
        st.bind(2, int: store)
        var out: [(Int64, Bool)] = []
        while try st.step() { out.append((st.int(0), st.int(1) != 0)) }
        txn.indexes[store] = out
        return out
    }

    /// Whether a unique index has the key for some other record.
    private func taken(index: Int64, key: [UInt16], by pk: [UInt16]) throws -> Bool {
        let st = try conn.statement("SELECT 1 FROM entries WHERE db = ? AND idx = ? AND key = ? AND pk != ? LIMIT 1")
        st.bind(1, int: db)
        st.bind(2, int: index)
        st.bind(3, key: key[...])
        st.bind(4, key: pk[...])
        defer { st.reset() }
        return try st.step()
    }

    private func put(_ op: [IDBWire]) throws -> IDBWire {
        let store = try op.int(1)
        let value = try op.units(3)
        let overwrite = try op.int(4) != 0
        let entryLists = op[safe: 5]?.list ?? []
        let template = op[safe: 6]?.units

        let (autoIncrement, generator) = try self.generator(of: store)

        // Every check before any write, so a put that fails leaves nothing.
        let key: [UInt16]
        let generated: Bool
        if let given = op[safe: 2]?.units {
            key = Array(given)
            generated = false
        } else {
            guard generator <= IDBKeys.generatorLimit else {
                throw IDBFailure("ConstraintError", "The key generator has run out of keys.")
            }
            key = IDBKeys.encode(number: Double(generator))
            generated = true
        }

        let indexes = try self.indexes(of: store)

        // A store with no indexes has no entries to clear for a record it
        // replaces, and needs no look first: one statement does it.
        if indexes.isEmpty {
            let write = try conn.statement(overwrite
                ? "INSERT OR REPLACE INTO records (db, store, key, value) VALUES (?, ?, ?, ?)"
                : "INSERT OR IGNORE INTO records (db, store, key, value) VALUES (?, ?, ?, ?)")
            write.bind(1, int: db)
            write.bind(2, int: store)
            write.bind(3, key: key[...])
            write.bind(4, units: value)
            try write.run()
            if !overwrite, conn.changes == 0 {
                throw IDBFailure("ConstraintError", "A record with this key already exists.")
            }
            advance(store, autoIncrement: autoIncrement, generator: generator, past: key)
            return generated ? .string(key[...]) : .number(0)
        }

        let exists = try conn.statement("SELECT 1 FROM records WHERE db = ? AND store = ? AND key = ?")
        exists.bind(1, int: db)
        exists.bind(2, int: store)
        exists.bind(3, key: key[...])
        let there = try exists.step()
        exists.reset()
        if there, !overwrite { throw IDBFailure("ConstraintError", "A record with this key already exists.") }

        let unique = Dictionary(indexes, uniquingKeysWith: { a, _ in a })
        var entries: [(Int64, [[UInt16]])] = []
        for item in entryLists {
            guard let pair = item.list, let index = pair[safe: 0]?.number, let keys = pair[safe: 1]?.list else { continue }
            let id = Int64(index)
            guard let isUnique = unique[id] else { throw IDBFailure("UnknownError", "No index \(id).") }
            let resolved: [[UInt16]] = keys.compactMap { $0.units }.map { k in
                template.map { IDBKeys.replace(k, template: $0, with: key) } ?? Array(k)
            }
            if isUnique {
                for k in resolved where try taken(index: id, key: k, by: key) {
                    throw IDBFailure("ConstraintError", "A unique index already has this key.")
                }
            }
            entries.append((id, resolved))
        }

        if there {
            let clear = try conn.statement("DELETE FROM entries WHERE db = ?1 AND idx IN (SELECT id FROM indexes WHERE db = ?1 AND store = ?2) AND pk = ?3")
            clear.bind(1, int: db)
            clear.bind(2, int: store)
            clear.bind(3, key: key[...])
            try clear.run()
        }
        let write = try conn.statement("INSERT OR REPLACE INTO records (db, store, key, value) VALUES (?, ?, ?, ?)")
        write.bind(1, int: db)
        write.bind(2, int: store)
        write.bind(3, key: key[...])
        write.bind(4, units: value)
        try write.run()
        if !entries.isEmpty {
            let add = try conn.statement("INSERT OR IGNORE INTO entries (db, idx, key, pk) VALUES (?, ?, ?, ?)")
            for (id, keys) in entries {
                for k in keys {
                    add.bind(1, int: db)
                    add.bind(2, int: id)
                    add.bind(3, key: k[...])
                    add.bind(4, key: key[...])
                    try add.run()
                }
            }
        }

        advance(store, autoIncrement: autoIncrement, generator: generator, past: key)
        return generated ? .string(key[...]) : .number(0)
    }

    /// A store's key generator: whether it has one, and its current number.
    private func generator(of store: Int64) throws -> (Bool, Int64) {
        if let known = txn.generators[store] { return (known.auto, known.value) }
        let gen = try conn.statement("SELECT auto_increment, generator FROM stores WHERE db = ? AND id = ?")
        gen.bind(1, int: db)
        gen.bind(2, int: store)
        defer { gen.reset() }
        guard try gen.step() else { throw IDBFailure("UnknownError", "No object store \(store).") }
        let found = (gen.int(0) != 0, gen.int(1))
        txn.generators[store] = (found.0, found.1, false)
        return found
    }

    /// The generator moves only for a put that got this far: past the key it
    /// made, or past an explicit number at or beyond it.
    private func advance(_ store: Int64, autoIncrement: Bool, generator: Int64, past key: [UInt16]) {
        guard autoIncrement, let n = IDBKeys.number(key[...]), n >= Double(generator) else { return }
        let next = n >= Double(IDBKeys.generatorLimit) ? IDBKeys.generatorLimit + 1 : Int64(n.rounded(.down)) + 1
        txn.generators[store] = (true, next, true)
    }

    /// `ia`: fill a new index, all or nothing.
    private func fill(_ op: [IDBWire]) throws -> IDBWire {
        let index = try op.int(1)
        let flag = try conn.statement("SELECT is_unique FROM indexes WHERE db = ? AND id = ?")
        flag.bind(1, int: db)
        flag.bind(2, int: index)
        guard try flag.step() else { flag.reset(); throw IDBFailure("UnknownError", "No index \(index).") }
        let unique = flag.int(0) != 0
        flag.reset()
        try conn.exec("SAVEPOINT fill")
        do {
            let add = try conn.statement("INSERT OR IGNORE INTO entries (db, idx, key, pk) VALUES (?, ?, ?, ?)")
            for row in op[safe: 2]?.list ?? [] {
                guard let pair = row.list, let pk = pair[safe: 0]?.units else { continue }
                let pkUnits = Array(pk)
                for key in pair[safe: 1]?.list ?? [] {
                    guard let k = key.units else { continue }
                    let units = Array(k)
                    if unique, try taken(index: index, key: units, by: pkUnits) {
                        throw IDBFailure("ConstraintError", "A unique index already has this key.")
                    }
                    add.bind(1, int: db)
                    add.bind(2, int: index)
                    add.bind(3, key: k)
                    add.bind(4, key: pk)
                    try add.run()
                }
            }
            try conn.exec("RELEASE fill")
        } catch {
            try? conn.exec("ROLLBACK TO fill")
            try? conn.exec("RELEASE fill")
            throw error
        }
        return .number(0)
    }

    /// The store an index belongs to.
    private func store(ofIndex index: Int64) throws -> Int64 {
        let st = try conn.statement("SELECT store FROM indexes WHERE db = ? AND id = ?")
        st.bind(1, int: db)
        st.bind(2, int: index)
        defer { st.reset() }
        guard try st.step() else { throw IDBFailure("UnknownError", "No index \(index).") }
        return st.int(0)
    }

    private func get(_ op: [IDBWire]) throws -> IDBWire {
        guard let source = op[safe: 1]?.ascii, let direction = op[safe: 5]?.ascii, let what = op[safe: 6]?.ascii else {
            throw IDBFailure.corrupt
        }
        let id = try op.int(2)
        let range = try IDBRange(op[safe: 3])
        let limit = try op.int(4)
        if what == "c" {
            var args: [IDBBinding] = [.int(db), .int(id)]
            let sql = source == "s"
                ? "SELECT count(*) FROM records WHERE db = ?1 AND store = ?2\(range.sql(column: "key", args: &args))"
                : "SELECT count(*) FROM entries WHERE db = ?1 AND idx = ?2\(range.sql(column: "key", args: &args))"
            let st = try conn.statement(sql)
            for (i, arg) in args.enumerated() { st.bind(Int32(i + 1), arg) }
            defer { st.reset() }
            _ = try st.step()
            return .number(Double(st.int(0)))
        }
        let rows = try select(source: source, id: id, range: range, direction: direction,
                              keysOnly: what == "k", position: nil, limit: limit)
        switch what {
        case "v": return .list(rows.map { .string($0.value![...]) })
        case "k": return .list(rows.map { .string($0.primaryKey[...]) })
        default: return .list(rows.map { .list([.string($0.key[...]), .string($0.primaryKey[...]), .string($0.value![...])]) })
        }
    }

    private func iterate(_ op: [IDBWire]) throws -> IDBWire {
        guard let source = op[safe: 1]?.ascii, let direction = op[safe: 4]?.ascii else { throw IDBFailure.corrupt }
        let id = try op.int(2)
        let range = try IDBRange(op[safe: 3])
        let keysOnly = try op.int(5) != 0
        var position: IDBPosition?
        if let p = op[safe: 6]?.list, let key = p[safe: 0]?.units {
            position = IDBPosition(key: Array(key), primaryKey: p[safe: 1]?.units.map(Array.init), inclusive: (p[safe: 2]?.number ?? 0) != 0)
        }
        let limit = try op.int(7)
        let rows = try select(source: source, id: id, range: range, direction: direction,
                              keysOnly: keysOnly, position: position, limit: limit)
        return .list(rows.map { row in
            .list([.string(row.key[...]), .string(row.primaryKey[...]), row.value.map { .string($0[...]) } ?? .null])
        })
    }

    private struct Row {
        let key: [UInt16]
        let primaryKey: [UInt16]
        let value: [UInt16]?
    }

    /**
     The records of a store or index in cursor order: inside `range`, past
     `position`, at most `limit` (0 for no limit). For the unique directions,
     of each run of equal index keys only the lowest primary key.
     */
    private func select(source: String, id: Int64, range: IDBRange, direction: String,
                        keysOnly: Bool, position: IDBPosition?, limit: Int64) throws -> [Row] {
        let reverse = direction == "p" || direction == "pu"
        let unique = direction == "nu" || direction == "pu"
        let order = reverse ? "DESC" : "ASC"
        var args: [IDBBinding] = [.int(db), .int(id)]
        var sql: String

        if source == "s" {
            var condition = range.sql(column: "key", args: &args)
            if let position {
                args.append(.key(position.key))
                condition += " AND key \(reverse ? "<" : ">")\(position.inclusive ? "=" : "") ?\(args.count)"
            }
            sql = "SELECT key, \(keysOnly ? "NULL" : "value") FROM records WHERE db = ?1 AND store = ?2\(condition) ORDER BY key \(order)"
        } else {
            let store = try self.store(ofIndex: id)
            var condition = range.sql(column: "e.key", args: &args)
            if let position {
                let op = "\(reverse ? "<" : ">")\(position.inclusive ? "=" : "")"
                args.append(.key(position.key))
                if let pk = position.primaryKey, !unique {
                    args.append(.key(pk))
                    condition += " AND (e.key, e.pk) \(op) (?\(args.count - 1), ?\(args.count))"
                } else {
                    condition += " AND e.key \(op) ?\(args.count)"
                }
            }
            var join = ""
            if !keysOnly {
                args.append(.int(store))
                join = " JOIN records r ON r.db = ?1 AND r.store = ?\(args.count) AND r.key = u.pk"
            }
            let value = keysOnly ? "NULL" : "r.value"
            if unique {
                sql = """
                SELECT u.key, u.pk, \(value) FROM (
                  SELECT e.key AS key, min(e.pk) AS pk FROM entries e
                  WHERE e.db = ?1 AND e.idx = ?2\(condition) GROUP BY e.key
                ) u\(join) ORDER BY u.key \(order)
                """
            } else {
                sql = """
                SELECT u.key, u.pk, \(value) FROM (
                  SELECT e.key AS key, e.pk AS pk FROM entries e
                  WHERE e.db = ?1 AND e.idx = ?2\(condition)
                ) u\(join) ORDER BY u.key \(order), u.pk \(order)
                """
            }
        }
        if limit > 0 {
            args.append(.int(limit))
            sql += " LIMIT ?\(args.count)"
        }

        let st = try conn.statement(sql)
        for (i, arg) in args.enumerated() { st.bind(Int32(i + 1), arg) }
        defer { st.reset() }
        var rows: [Row] = []
        let keyed = source != "s"
        while try st.step() {
            let key = st.key(0)
            let pk = keyed ? st.key(1) : key
            let valueColumn: Int32 = keyed ? 2 : 1
            rows.append(Row(key: key, primaryKey: pk, value: st.isNull(valueColumn) ? nil : st.units(valueColumn)))
        }
        return rows
    }
}

private struct IDBPosition {
    let key: [UInt16]
    let primaryKey: [UInt16]?
    let inclusive: Bool
}

private struct IDBRange {
    var lower: [UInt16]?
    var upper: [UInt16]?
    var lowerOpen = false
    var upperOpen = false

    init(_ wire: IDBWire?) throws {
        guard let wire, case let .list(list) = wire else { return }
        lower = list[safe: 0]?.units.map(Array.init)
        upper = list[safe: 1]?.units.map(Array.init)
        lowerOpen = (list[safe: 2]?.number ?? 0) != 0
        upperOpen = (list[safe: 3]?.number ?? 0) != 0
    }

    /// ` AND column >= ?n …`, its bindings appended to `args`.
    func sql(column: String, args: inout [IDBBinding]) -> String {
        var out = ""
        if let lower {
            args.append(.key(lower))
            out += " AND \(column) \(lowerOpen ? ">" : ">=") ?\(args.count)"
        }
        if let upper {
            args.append(.key(upper))
            out += " AND \(column) \(upperOpen ? "<" : "<=") ?\(args.count)"
        }
        return out
    }
}

// MARK: - Keys

enum IDBKeys {
    /// The largest key a key generator may produce, 2^53.
    static let generatorLimit: Int64 = 9_007_199_254_740_992

    /// The number an encoded number key holds.
    static func number(_ key: ArraySlice<UInt16>) -> Double? {
        guard key.count >= 5, key.first == 1 else { return nil }
        let i = key.startIndex
        var a = UInt64(key[i + 1]), b = UInt64(key[i + 2]), c = UInt64(key[i + 3]), d = UInt64(key[i + 4])
        if a & 0x8000 != 0 {
            a &= 0x7fff
        } else {
            a = ~a & 0xffff; b = ~b & 0xffff; c = ~c & 0xffff; d = ~d & 0xffff
        }
        return Double(bitPattern: a << 48 | b << 32 | c << 16 | d)
    }

    /// A number's encoded key, as `keys.ts` makes it.
    static func encode(number: Double) -> [UInt16] {
        let bits = (number == 0 ? 0.0 : number).bitPattern
        var a = UInt16(truncatingIfNeeded: bits >> 48), b = UInt16(truncatingIfNeeded: bits >> 32)
        var c = UInt16(truncatingIfNeeded: bits >> 16), d = UInt16(truncatingIfNeeded: bits)
        if a & 0x8000 != 0 {
            a = ~a; b = ~b; c = ~c; d = ~d
        } else {
            a |= 0x8000
        }
        return [1, a, b, c, d]
    }

    /// `key` with every occurrence of `template` replaced by `with`.
    static func replace(_ key: ArraySlice<UInt16>, template: ArraySlice<UInt16>, with value: [UInt16]) -> [UInt16] {
        let t = Array(template)
        guard !t.isEmpty, key.count >= t.count else { return Array(key) }
        var out: [UInt16] = []
        out.reserveCapacity(key.count)
        var i = key.startIndex
        while i < key.endIndex {
            if key.endIndex - i >= t.count, key[i] == t[0], key[i ..< i + t.count].elementsEqual(t) {
                out.append(contentsOf: value)
                i += t.count
            } else {
                out.append(key[i])
                i += 1
            }
        }
        return out
    }
}

// MARK: - The wire

/// A message: see `src/lib/idb/wire.ts`.
indirect enum IDBWire {
    case string(ArraySlice<UInt16>)
    case number(Double)
    case null
    case list([IDBWire])

    var units: ArraySlice<UInt16>? {
        if case let .string(s) = self { return s }
        return nil
    }

    /// A string that is plain ASCII, as commands and ids are.
    var ascii: String? {
        guard case let .string(s) = self, s.allSatisfy({ $0 < 0x80 }) else { return nil }
        return String(decoding: s.map { UInt8($0) }, as: UTF8.self)
    }

    var number: Double? {
        if case let .number(n) = self { return n }
        return nil
    }

    var list: [IDBWire]? {
        if case let .list(l) = self { return l }
        return nil
    }

    var encoded: [UInt16] {
        var out: [UInt16] = []
        write(into: &out)
        return out
    }

    private func write(into out: inout [UInt16]) {
        switch self {
        case let .string(s):
            out.append(0x73)
            out.append(contentsOf: String(s.count).utf16)
            out.append(0x3A)
            out.append(contentsOf: s)
        case let .number(n):
            out.append(0x69)
            let text: String
            if n.isNaN {
                text = "NaN"
            } else if n.isInfinite {
                text = n < 0 ? "-Infinity" : "Infinity"
            } else if n == n.rounded(), abs(n) < 1e15 {
                text = String(Int64(n))
            } else {
                text = String(n)
            }
            out.append(contentsOf: text.utf16)
            out.append(0x3B)
        case .null:
            out.append(0x6E)
        case let .list(items):
            out.append(0x5B)
            for item in items { item.write(into: &out) }
            out.append(0x5D)
        }
    }
}

struct IDBWireParser {
    private let units: [UInt16]
    private var at = 0

    init(_ units: [UInt16]) {
        self.units = units
    }

    mutating func parse() throws -> IDBWire {
        guard at < units.count else { throw IDBFailure.corrupt }
        let tag = units[at]
        at += 1
        switch tag {
        case 0x73:
            let length = try integer(until: 0x3A)
            let start = at
            at += length
            guard length >= 0, at <= units.count else { throw IDBFailure.corrupt }
            return .string(units[start ..< at])
        case 0x69:
            let text = try ascii(until: 0x3B)
            guard let n = Double(text) else { throw IDBFailure.corrupt }
            return .number(n)
        case 0x6E:
            return .null
        case 0x5B:
            var items: [IDBWire] = []
            while at < units.count, units[at] != 0x5D { items.append(try parse()) }
            guard at < units.count else { throw IDBFailure.corrupt }
            at += 1
            return .list(items)
        default:
            throw IDBFailure.corrupt
        }
    }

    private mutating func ascii(until end: UInt16) throws -> String {
        var bytes: [UInt8] = []
        while at < units.count, units[at] != end {
            guard units[at] < 0x80 else { throw IDBFailure.corrupt }
            bytes.append(UInt8(units[at]))
            at += 1
        }
        guard at < units.count else { throw IDBFailure.corrupt }
        at += 1
        return String(decoding: bytes, as: UTF8.self)
    }

    private mutating func integer(until end: UInt16) throws -> Int {
        guard let n = Int(try ascii(until: end)) else { throw IDBFailure.corrupt }
        return n
    }
}

extension Array where Element == IDBWire {
    subscript(safe index: Int) -> IDBWire? {
        index < count ? self[index] : nil
    }

    fileprivate func int(_ index: Int) throws -> Int64 {
        guard let n = self[safe: index]?.number else { throw IDBFailure.corrupt }
        return Int64(n)
    }

    fileprivate func units(_ index: Int) throws -> ArraySlice<UInt16> {
        guard let s = self[safe: index]?.units else { throw IDBFailure.corrupt }
        return s
    }
}

// MARK: - Failures

/// A DOMException name and message, as an op's answer carries them.
struct IDBFailure: Error {
    let name: String
    let message: String

    init(_ name: String, _ message: String) {
        self.name = name
        self.message = message
    }

    static let corrupt = IDBFailure("UnknownError", "The message could not be read.")

    var wire: IDBWire {
        .list([.string(ArraySlice("!".utf16)), .string(ArraySlice(name.utf16)), .string(ArraySlice(message.utf16))])
    }

    static func from(_ error: Error) -> IDBFailure {
        if let failure = error as? IDBFailure { return failure }
        if let sqlite = error as? IDBSQLiteError {
            switch sqlite.code & 0xff {
            case SQLITE_FULL: return IDBFailure("QuotaExceededError", sqlite.message)
            case SQLITE_BUSY, SQLITE_LOCKED: return IDBFailure("UnknownError", "The database is busy: \(sqlite.message)")
            default: return IDBFailure("UnknownError", sqlite.message)
            }
        }
        return IDBFailure("UnknownError", String(describing: error))
    }
}

// MARK: - SQLite

/**
 The tables every database file has.

 A file carries the version of this layout it was made with as SQLite's
 `user_version`. A change to the layout is a new version, and a file made
 with an older one is brought up to date by the build that knows both; a
 file made by a newer build than this one is refused rather than misread.
 */
private enum IDBSchema {
    static let version: Int64 = 1

    static let create = """
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS databases (
      id INTEGER PRIMARY KEY,
      name BLOB NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      incarnation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stores (
      db INTEGER NOT NULL, id INTEGER NOT NULL, name BLOB NOT NULL, key_path BLOB,
      auto_increment INTEGER NOT NULL, generator INTEGER NOT NULL,
      PRIMARY KEY (db, id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS indexes (
      db INTEGER NOT NULL, id INTEGER NOT NULL, store INTEGER NOT NULL, name BLOB NOT NULL,
      key_path BLOB NOT NULL, is_unique INTEGER NOT NULL, multi_entry INTEGER NOT NULL,
      PRIMARY KEY (db, id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS records (
      db INTEGER NOT NULL, store INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY (db, store, key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS entries (
      db INTEGER NOT NULL, idx INTEGER NOT NULL, key BLOB NOT NULL, pk BLOB NOT NULL,
      PRIMARY KEY (db, idx, key, pk)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS entries_by_pk ON entries (db, idx, pk);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
    """
}

struct IDBSQLiteError: Error {
    let code: Int32
    let message: String
}

private let SQLITE_TRANSIENT_DESTRUCTOR = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private enum IDBBinding {
    case int(Int64)
    case key([UInt16])
}

/// One SQLite connection and its prepared statements. Used by one thread at a
/// time — whoever holds it — never concurrently.
final class IDBConnection {
    fileprivate let db: OpaquePointer
    private var statements: [String: IDBStatement] = [:]

    init(path: String, busyTimeout: Int32 = 10_000) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        let rc = sqlite3_open_v2(path, &handle, flags, nil)
        guard rc == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open"
            if let handle { sqlite3_close_v2(handle) }
            throw IDBSQLiteError(code: rc, message: message)
        }
        db = handle
        sqlite3_busy_timeout(db, busyTimeout)
        try exec("PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;")
    }

    deinit {
        statements.removeAll()
        sqlite3_close_v2(db)
    }

    func exec(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &error)
        if rc != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? "error \(rc)"
            sqlite3_free(error)
            throw IDBSQLiteError(code: rc, message: message)
        }
    }

    fileprivate func statement(_ sql: String) throws -> IDBStatement {
        if let st = statements[sql] {
            st.reset()
            return st
        }
        var handle: OpaquePointer?
        let rc = sqlite3_prepare_v3(db, sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &handle, nil)
        guard rc == SQLITE_OK, let handle else {
            throw IDBSQLiteError(code: rc, message: String(cString: sqlite3_errmsg(db)))
        }
        let st = IDBStatement(handle, connection: self)
        statements[sql] = st
        return st
    }

    /// Reset every statement, ending any read one left open.
    func resetAll() {
        var st = sqlite3_next_stmt(db, nil)
        while let handle = st {
            sqlite3_reset(handle)
            st = sqlite3_next_stmt(db, handle)
        }
    }

    /// Rows the last statement changed.
    fileprivate var changes: Int32 {
        sqlite3_changes(db)
    }

    fileprivate var lastInsertRowId: Int64 {
        sqlite3_last_insert_rowid(db)
    }
}

private final class IDBStatement {
    let handle: OpaquePointer
    unowned let connection: IDBConnection

    init(_ handle: OpaquePointer, connection: IDBConnection) {
        self.handle = handle
        self.connection = connection
    }

    deinit {
        sqlite3_finalize(handle)
    }

    func reset() {
        sqlite3_reset(handle)
        sqlite3_clear_bindings(handle)
    }

    func bind(_ index: Int32, _ binding: IDBBinding) {
        switch binding {
        case let .int(n): bind(index, int: n)
        case let .key(k): bind(index, key: k[...])
        }
    }

    func bind(_ index: Int32, int: Int64) {
        sqlite3_bind_int64(handle, index, int)
    }

    func bindNull(_ index: Int32) {
        sqlite3_bind_null(handle, index)
    }

    func bind(_ index: Int32, text: String) {
        sqlite3_bind_text(handle, index, text, -1, SQLITE_TRANSIENT_DESTRUCTOR)
    }

    /// Units as they are, for values and names: only ever compared whole.
    func bind(_ index: Int32, units: ArraySlice<UInt16>) {
        if units.isEmpty {
            sqlite3_bind_zeroblob(handle, index, 0)
            return
        }
        units.withUnsafeBytes { bytes in
            _ = sqlite3_bind_blob(handle, index, bytes.baseAddress, Int32(bytes.count), SQLITE_TRANSIENT_DESTRUCTOR)
        }
    }

    /// Units big-endian, for keys: so that `memcmp` is key order.
    func bind(_ index: Int32, key: ArraySlice<UInt16>) {
        var bytes = [UInt8](repeating: 0, count: key.count * 2)
        var i = 0
        for unit in key {
            bytes[i] = UInt8(unit >> 8)
            bytes[i + 1] = UInt8(unit & 0xff)
            i += 2
        }
        if bytes.isEmpty {
            sqlite3_bind_zeroblob(handle, index, 0)
            return
        }
        bytes.withUnsafeBytes { raw in
            _ = sqlite3_bind_blob(handle, index, raw.baseAddress, Int32(raw.count), SQLITE_TRANSIENT_DESTRUCTOR)
        }
    }

    /// True while there is a row.
    func step() throws -> Bool {
        let rc = sqlite3_step(handle)
        if rc == SQLITE_ROW { return true }
        if rc == SQLITE_DONE { return false }
        throw IDBSQLiteError(code: rc, message: String(cString: sqlite3_errmsg(connection.db)))
    }

    /// Step to the end, for a statement that returns nothing.
    func run() throws {
        defer { reset() }
        while try step() {}
    }

    func int(_ column: Int32) -> Int64 {
        sqlite3_column_int64(handle, column)
    }

    func isNull(_ column: Int32) -> Bool {
        sqlite3_column_type(handle, column) == SQLITE_NULL
    }

    func text(_ column: Int32) -> String {
        guard let pointer = sqlite3_column_text(handle, column) else { return "" }
        return String(cString: pointer)
    }

    func units(_ column: Int32) -> [UInt16] {
        let count = Int(sqlite3_column_bytes(handle, column)) / 2
        guard count > 0, let pointer = sqlite3_column_blob(handle, column) else { return [] }
        var out = [UInt16](repeating: 0, count: count)
        out.withUnsafeMutableBytes { $0.copyMemory(from: UnsafeRawBufferPointer(start: pointer, count: count * 2)) }
        return out
    }

    func key(_ column: Int32) -> [UInt16] {
        let bytes = Int(sqlite3_column_bytes(handle, column))
        guard bytes > 0, let pointer = sqlite3_column_blob(handle, column) else { return [] }
        let raw = pointer.assumingMemoryBound(to: UInt8.self)
        var out = [UInt16](repeating: 0, count: bytes / 2)
        for i in 0 ..< out.count { out[i] = UInt16(raw[2 * i]) << 8 | UInt16(raw[2 * i + 1]) }
        return out
    }
}
