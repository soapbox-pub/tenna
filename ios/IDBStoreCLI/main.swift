import Foundation

// `NsiteIndexedDB` on the command line, so the conformance tests can run
// against the SQLite store itself rather than `memoryStore.ts`.
//
// Not part of the app. Built on a Mac by hand:
//
//     swiftc -O ios/App/NsiteNotify/NsiteIndexedDB.swift ios/IDBStoreCLI/*.swift -o /tmp/idbstore
//
// and pointed at by `WPT_STORE` when running `src/lib/idb/wpt.test.ts`, which
// starts one per test file with a fresh directory for the site's databases as
// its argument.
//
// Messages arrive on stdin and answers leave on stdout as frames:
// a little-endian u32 request id, u32 byte length, u32 status (0 answered,
// 1 failed), then that many bytes of UTF-16LE — the protocol's own units,
// lone surrogates and all. Answers may come out of order; the id pairs them.

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: idbstore <directory>\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
NsiteIndexedDB.location = { _ in URL(fileURLWithPath: path) }

let site = NsiteIndexedDB.site("cli")
let channel = NsiteIndexedDBChannel()
let output = FileHandle.standardOutput

func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

func u32(_ data: Data, _ at: Int) -> UInt32 {
    data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: at, as: UInt32.self)) }
}

func send(id: UInt32, status: UInt32, units: [UInt16]) {
    var frame = Data(capacity: 12 + units.count * 2)
    for word in [id, UInt32(units.count * 2), status] {
        withUnsafeBytes(of: word.littleEndian) { frame.append(contentsOf: $0) }
    }
    units.withUnsafeBytes { frame.append(contentsOf: $0) }
    output.write(frame)
}

Thread {
    while let header = readExactly(8) {
        let id = u32(header, 0)
        let length = Int(u32(header, 4))
        guard let body = readExactly(length) else { break }
        var units = [UInt16](repeating: 0, count: length / 2)
        units.withUnsafeMutableBytes { $0.copyBytes(from: body) }
        DispatchQueue.main.async {
            site.receive(units, from: channel) { result in
                switch result {
                case let .success(answer): send(id: id, status: 0, units: answer)
                case let .failure(failure): send(id: id, status: 1, units: Array("\(failure.name): \(failure.message)".utf16))
                }
            }
        }
    }
    DispatchQueue.main.async { exit(0) }
}.start()

dispatchMain()
