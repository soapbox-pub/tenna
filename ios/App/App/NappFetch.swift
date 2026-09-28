import Compression
import Foundation
import Network
import WebKit

/**
 `napp.fetch`: an HTTP request made on a site's behalf, without CORS.

 The iOS counterpart of `NappFetch.java`, with the same shape on the wire —
 `napp.fetch.begin` stages a request and returns a ticket, `napp.fetch.body`
 hands over its body, and a same-origin GET of `/.napp/fetch?t=<ticket>` is
 answered with the response, streamed. That GET reaches `NsiteSchemeHandler`
 (or the worker host's handler) because the site is on Tenna's own scheme, so
 what the site is handed is a real `Response` with a real streaming body, as on
 Android. See NAPP.md.

 ## Why not URLSession

 The rule that makes lifting CORS defensible is that nothing on the local
 network can be reached, and it has to hold for **the address actually
 connected to** — a name the site controls can resolve to `127.0.0.1`. Android
 enforces that in the resolver OkHttp is given. `URLSession` has no such hook,
 so the name is resolved here, every address it has is checked, and
 `NWConnection` is pointed at the address itself, with the name given to TLS
 for SNI and for checking the certificate. What was checked is what is
 connected to; a second lookup that answers differently is never made. On
 every redirect hop, again.

 That makes this an HTTP/1.1 client of its own. It asks for `identity` and
 closes the connection after each exchange, which keeps it small: no pooling,
 no HTTP/2, and a gzip body only when a server ignores the ask.
 */
enum NappFetch {

    struct Refused: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    /// A request a site has described and not yet collected.
    private struct Staged {
        let siteId: String
        let url: URL
        let method: String
        let headers: [(String, String)]
        let redirect: String
        let hasBody: Bool
        var body: Data?
        let created: Date
    }

    private static let lock = NSLock()
    private static var staged: [String: Staged] = [:]
    private static var inFlight: [String: Int] = [:]
    private static var running: [String: Task<Void, Never>] = [:]

    // MARK: - Staging

    /// `napp.fetch.begin`: check what the site asked for and hand back a ticket.
    static func stage(siteId: String, params: [String: Any]) throws -> String {
        guard let text = params["url"] as? String, let url = URL(string: text) else {
            throw Refused("Not a URL")
        }
        if let refusal = NappFetchPolicy.refuse(url: url) { throw Refused(refusal) }
        guard let method = NappFetchPolicy.normalize(method: params["method"] as? String) else {
            throw Refused("That method is not allowed")
        }

        var headers: [(String, String)] = []
        for pair in params["headers"] as? [Any] ?? [] {
            guard let pair = pair as? [Any], pair.count == 2,
                  let name = pair[0] as? String, let value = pair[1] as? String else { continue }
            guard !NappFetchPolicy.isForbiddenRequestHeader(name) else {
                throw Refused("The \(name) header cannot be set")
            }
            guard NappFetchPolicy.isValidHeaderValue(value) else { throw Refused("Malformed header value") }
            headers.append((name, value))
        }

        let redirect = params["redirect"] as? String ?? "follow"
        let hasBody = (params["hasBody"] as? Bool ?? false) && NappFetchPolicy.allowsBody(method)

        let ticket = UUID().uuidString.lowercased()
        lock.lock()
        defer { lock.unlock() }
        sweep()
        guard (inFlight[siteId] ?? 0) + staged.values.filter({ $0.siteId == siteId }).count
                < NappFetchPolicy.maxInFlightPerSite else {
            throw Refused("Too many requests in flight")
        }
        staged[ticket] = Staged(
            siteId: siteId, url: url, method: method, headers: headers,
            redirect: redirect, hasBody: hasBody, body: nil, created: Date())
        return ticket
    }

    /// `napp.fetch.body`: the request's body, base64url, all at once.
    static func body(siteId: String, ticket: String, encoded: String) throws {
        guard let body = decodeBase64URL(encoded) else { throw Refused("Malformed body") }
        guard body.count <= NappFetchPolicy.maxBodyBytes else { throw Refused("The request body is too large") }
        lock.lock()
        defer { lock.unlock() }
        guard var request = staged[ticket], request.siteId == siteId else { throw Refused("No such request") }
        request.body = body
        staged[ticket] = request
    }

    /// `napp.fetch.abort`, or the site going away.
    static func abort(siteId: String, ticket: String) {
        lock.lock()
        let task = running.removeValue(forKey: ticket)
        if staged[ticket]?.siteId == siteId { staged.removeValue(forKey: ticket) }
        lock.unlock()
        task?.cancel()
    }

    /// Callers hold `lock`. A ticket nobody collected is let go after a while.
    private static func sweep() {
        let cutoff = Date().addingTimeInterval(-NappFetchPolicy.ticketTTL)
        staged = staged.filter { $0.value.created > cutoff }
    }

    // MARK: - Running

    /// Where a response goes. Called on the main actor, in order: `head` once,
    /// `data` any number of times, then `finish` — or `fail` at any point.
    struct Sink {
        let head: @MainActor (_ status: Int, _ headers: [String: String]) -> Void
        let data: @MainActor (Data) -> Void
        let finish: @MainActor () -> Void
        let fail: @MainActor (String) -> Void
    }

    /**
     Collect a ticket: make the request and stream the answer into `sink`.

     Returns a cancel function for the scheme task being stopped, or nil if
     the ticket was not the site's to collect — which the caller answers as a
     failure itself.
     */
    @MainActor
    static func run(siteId: String, ticket: String, sink: Sink) -> (() -> Void)? {
        lock.lock()
        guard let request = staged.removeValue(forKey: ticket), request.siteId == siteId else {
            lock.unlock()
            return nil
        }
        inFlight[siteId, default: 0] += 1
        lock.unlock()

        if request.hasBody, request.body == nil {
            finished(siteId: siteId, ticket: ticket)
            sink.fail("The request body never arrived")
            return {}
        }

        let task = Task { @MainActor in
            defer { finished(siteId: siteId, ticket: ticket) }
            do {
                try await perform(request, sink: sink)
            } catch is CancellationError {
                // Nobody left to tell.
            } catch {
                guard !Task.isCancelled else { return }
                sink.fail((error as? LocalizedError)?.errorDescription ?? "Failed to fetch")
            }
        }
        lock.lock()
        running[ticket] = task
        lock.unlock()
        return { task.cancel() }
    }

    private static func finished(siteId: String, ticket: String) {
        lock.lock()
        running.removeValue(forKey: ticket)
        inFlight[siteId] = max(0, (inFlight[siteId] ?? 1) - 1)
        lock.unlock()
    }

    @MainActor
    private static func perform(_ request: Staged, sink: Sink) async throws {
        var url = request.url
        var method = request.method
        var headers = request.headers
        var body = request.body

        for hop in 0...NappFetchPolicy.maxRedirects {
            let exchange = NappHTTPExchange(url: url, method: method, headers: headers, body: body)
            let head = try await exchange.start()

            if NappFetchPolicy.isRedirect(head.status),
               let location = head.header("location"),
               let next = URL(string: location, relativeTo: url)?.absoluteURL {
                exchange.cancel()
                guard request.redirect != "error" else { throw Refused("Redirects are not allowed") }
                guard hop < NappFetchPolicy.maxRedirects else { throw Refused("Too many redirects") }
                if let refusal = NappFetchPolicy.refuse(url: next) { throw Refused(refusal) }

                if NappFetchPolicy.redirectBecomesGet(status: head.status, method: method) {
                    method = "GET"
                    body = nil
                    headers.removeAll { ["content-type", "content-encoding", "content-language", "content-location"]
                        .contains($0.0.lowercased()) }
                }
                // A credential for one host is not one for the next.
                if next.host?.lowercased() != url.host?.lowercased() {
                    headers.removeAll { $0.0.lowercased() == "authorization" }
                }
                url = next
                continue
            }

            var out: [String: String] = [:]
            for (name, value) in head.headers where !NappFetchPolicy.isStrippedResponseHeader(name) {
                out[name] = out[name].map { "\($0), \(value)" } ?? value
            }
            out["X-Napp-Final-Url"] = url.absoluteString
            sink.head(head.status, out)

            try await exchange.stream { sink.data($0) }
            sink.finish()
            return
        }
        throw Refused("Too many redirects")
    }

    private static func decodeBase64URL(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        return Data(base64Encoded: base64)
    }
}

// MARK: - One exchange

/**
 One HTTP/1.1 request and its response, over one connection.

 `start` connects, checks where it got to, writes the request and reads up to
 the end of the response's headers; `stream` reads the body. Cancelling the
 task either runs in closes the connection, which ends whichever is waiting.
 */
@MainActor
final class NappHTTPExchange {

    struct Head {
        let status: Int
        let headers: [(String, String)]

        func header(_ name: String) -> String? {
            headers.first { $0.0.lowercased() == name }?.1
        }
    }

    private let url: URL
    private let method: String
    private let headers: [(String, String)]
    private let body: Data?

    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "pub.soapbox.tenna.napp-fetch")
    private var buffer = Data()
    private var head: Head?
    private var eof = false
    /// Set when the headers took too long, so the cancellation that follows
    /// is reported as a timeout rather than as nobody listening.
    private var timedOut = false

    init(url: URL, method: String, headers: [(String, String)], body: Data?) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
    }

    func cancel() {
        connection?.cancel()
        connection = nil
    }

    /// Whichever state arrives first answers the wait for a connection.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func run(_ body: () -> Void) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { body() }
        }
    }

    // MARK: Connecting and asking

    func start() async throws -> Head {
        guard let host = url.host, !host.isEmpty else { throw NappFetch.Refused("No host") }
        let port = url.port ?? 443

        let deadline = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(NappFetchPolicy.headersTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.timedOut = true
            self?.cancel()
        }
        defer { deadline.cancel() }

        do {
            return try await withTaskCancellationHandler {
                try await connect(host: host, port: port)
                try await send(request(host: host, port: port))
                if let body, !body.isEmpty { try await send(body) }
                return try await readHead()
            } onCancel: {
                Task { @MainActor [weak self] in self?.cancel() }
            }
        } catch {
            if timedOut { throw NappFetch.Refused("The request timed out") }
            throw error
        }
    }

    private func connect(host: String, port: Int) async throws {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = Int(NappFetchPolicy.headersTimeout)
        let parameters = NWParameters(tls: tls, tcp: tcp)
        parameters.prohibitedInterfaceTypes = [.loopback]

        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { throw NappFetch.Refused("Bad port") }
        let addresses = try await Self.resolve(host)
        // The name, for SNI and for the certificate, since the endpoint is a
        // bare address. An address literal has no name to give.
        if IPv4Address(host) == nil, IPv6Address(host) == nil {
            sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, host)
        }

        var lastError: Error = NappFetch.Refused("Failed to fetch")
        for address in addresses {
            do {
                try await connect(to: address, port: nwPort, using: parameters)
                return
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /**
     Every address `host` has, checked. Any one of them being on the local
     network refuses the lot: a name that answers with both a public and a
     private address is one whose owner is choosing which, per lookup.
     */
    private static func resolve(_ host: String) async throws -> [NWEndpoint.Host] {
        if let v4 = IPv4Address(host) {
            if let refusal = NappFetchPolicy.refuse(address: [UInt8](v4.rawValue)) { throw NappFetch.Refused(refusal) }
            return [.ipv4(v4)]
        }
        if let v6 = IPv6Address(host) {
            if let refusal = NappFetchPolicy.refuse(address: [UInt8](v6.rawValue)) { throw NappFetch.Refused(refusal) }
            return [.ipv6(v6)]
        }

        let found: [[UInt8]] = try await Task.detached {
            var hints = addrinfo()
            hints.ai_family = AF_UNSPEC
            hints.ai_socktype = SOCK_STREAM
            var list: UnsafeMutablePointer<addrinfo>?
            let status = getaddrinfo(host, nil, &hints, &list)
            guard status == 0, let first = list else {
                throw NappFetch.Refused("Failed to fetch: could not resolve \(host)")
            }
            defer { freeaddrinfo(first) }

            var out: [[UInt8]] = []
            var node: UnsafeMutablePointer<addrinfo>? = first
            while let entry = node {
                if let address = entry.pointee.ai_addr {
                    if entry.pointee.ai_family == AF_INET {
                        var v4 = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                        out.append(withUnsafeBytes(of: &v4) { Array($0) })
                    } else if entry.pointee.ai_family == AF_INET6 {
                        var v6 = address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                        out.append(withUnsafeBytes(of: &v6) { Array($0) })
                    }
                }
                node = entry.pointee.ai_next
            }
            return out
        }.value

        var hosts: [NWEndpoint.Host] = []
        for bytes in found {
            if let refusal = NappFetchPolicy.refuse(address: bytes) { throw NappFetch.Refused(refusal) }
            if bytes.count == 4, let v4 = IPv4Address(Data(bytes)) {
                hosts.append(.ipv4(v4))
            } else if bytes.count == 16, let v6 = IPv6Address(Data(bytes)) {
                hosts.append(.ipv6(v6))
            }
        }
        guard !hosts.isEmpty else { throw NappFetch.Refused("Failed to fetch: could not resolve \(host)") }
        // Unique, in the resolver's order.
        var seen = Set<String>()
        return hosts.filter { seen.insert("\($0)").inserted }
    }

    private func connect(to address: NWEndpoint.Host, port nwPort: NWEndpoint.Port,
                         using parameters: NWParameters) async throws {
        let connection = NWConnection(host: address, port: nwPort, using: parameters)
        self.connection = connection

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Once()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume() }
                case .failed(let error), .waiting(let error):
                    once.run {
                        connection.cancel()
                        continuation.resume(throwing: NappFetch.Refused("Failed to fetch: \(error.localizedDescription)"))
                    }
                case .cancelled:
                    once.run { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }

        // Where it really went, before anything is said to it.
        guard case .hostPort(let reached, _)? = connection.currentPath?.remoteEndpoint else {
            cancel()
            throw NappFetch.Refused("Could not tell where the connection went")
        }
        let refusal: String?
        switch reached {
        case .ipv4(let address): refusal = NappFetchPolicy.refuse(address: [UInt8](address.rawValue))
        case .ipv6(let address): refusal = NappFetchPolicy.refuse(address: [UInt8](address.rawValue))
        default: refusal = "Could not tell where the connection went"
        }
        if let refusal {
            cancel()
            throw NappFetch.Refused(refusal)
        }
    }

    private func request(host: String, port: Int) -> Data {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var target = parts?.percentEncodedPath ?? "/"
        if target.isEmpty { target = "/" }
        if let query = parts?.percentEncodedQuery { target += "?" + query }

        var hostHeader = host.contains(":") ? "[\(host)]" : host
        if port != 443 { hostHeader += ":\(port)" }

        var text = "\(method) \(target) HTTP/1.1\r\nHost: \(hostHeader)\r\n"
        for (name, value) in headers { text += "\(name): \(value)\r\n" }
        if !headers.contains(where: { $0.0.lowercased() == "user-agent" }) { text += "User-Agent: Tenna\r\n" }
        if !headers.contains(where: { $0.0.lowercased() == "accept" }) { text += "Accept: */*\r\n" }
        if let body {
            text += "Content-Length: \(body.count)\r\n"
        } else if NappFetchPolicy.allowsBody(method) {
            text += "Content-Length: 0\r\n"
        }
        text += "Accept-Encoding: identity\r\nConnection: close\r\n\r\n"
        return Data(text.utf8)
    }

    private func send(_ data: Data) async throws {
        guard let connection else { throw CancellationError() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: NappFetch.Refused("Failed to fetch: \(error.localizedDescription)"))
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// More bytes into `buffer`, or `eof`. False once there are none.
    private func fill() async throws -> Bool {
        guard !eof else { return false }
        guard let connection else { throw CancellationError() }
        let (data, done) = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<(Data?, Bool), Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, complete, error in
                if let error, data == nil {
                    continuation.resume(throwing: NappFetch.Refused("Failed to fetch: \(error.localizedDescription)"))
                } else {
                    continuation.resume(returning: (data, complete))
                }
            }
        }
        if let data { buffer.append(data) }
        if done { eof = true }
        return data?.isEmpty == false || !done
    }

    // MARK: Reading the answer

    private static let crlf = Data("\r\n".utf8)
    private static let blank = Data("\r\n\r\n".utf8)

    private func readHead() async throws -> Head {
        while true {
            while buffer.range(of: Self.blank) == nil {
                guard buffer.count < 64 * 1024 else { throw NappFetch.Refused("The response headers are too large") }
                guard try await fill() else { throw NappFetch.Refused("The server closed the connection") }
            }
            let end = buffer.range(of: Self.blank)!
            let text = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
            buffer = Data(buffer[end.upperBound...])

            var lines = text.components(separatedBy: "\r\n")
            let statusLine = lines.removeFirst().split(separator: " ", maxSplits: 2)
            guard statusLine.count >= 2, statusLine[0].hasPrefix("HTTP/1."),
                  let status = Int(statusLine[1]), NappFetchPolicy.isServable(status: status) else {
                throw NappFetch.Refused("Malformed response")
            }
            var headers: [(String, String)] = []
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers.append((String(line[..<colon]).trimmingCharacters(in: .whitespaces),
                                String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)))
            }
            // An interim answer — 100 Continue, 103 Early Hints — is not the answer.
            if (100...199).contains(status) { continue }

            let head = Head(status: status, headers: headers)
            self.head = head
            return head
        }
    }

    /// The body, handed to `emit` as it arrives, within the ceiling.
    func stream(_ emit: @escaping @MainActor (Data) -> Void) async throws {
        guard let head else { return }
        defer { cancel() }
        if method == "HEAD" || NappFetchPolicy.isBodiless(status: head.status) { return }

        let encoding = head.header("content-encoding")?.lowercased() ?? "identity"
        let decoder: NappInflater?
        switch encoding {
        case "identity", "": decoder = nil
        case "gzip", "x-gzip": decoder = NappInflater(gzip: true)
        case "deflate": decoder = NappInflater(gzip: false)
        default: throw NappFetch.Refused("Unsupported content encoding \(encoding)")
        }

        var total = 0
        func deliver(_ chunk: Data) throws {
            guard !chunk.isEmpty else { return }
            let plain = try decoder?.push(chunk) ?? chunk
            total += plain.count
            guard total <= NappFetchPolicy.maxResponseBytes else {
                throw NappFetch.Refused("The response is too large")
            }
            if !plain.isEmpty { emit(plain) }
        }

        if head.header("transfer-encoding")?.lowercased().contains("chunked") == true {
            try await readChunked(deliver)
        } else if let length = head.header("content-length").flatMap({ Int($0) }) {
            var left = length
            while left > 0 {
                if buffer.isEmpty {
                    guard try await fill() else { throw NappFetch.Refused("The response ended early") }
                }
                let take = min(left, buffer.count)
                let piece = Data(buffer.prefix(take))
                buffer.removeFirst(take)
                left -= take
                try deliver(piece)
            }
        } else {
            while true {
                if !buffer.isEmpty {
                    try deliver(buffer)
                    buffer = Data()
                }
                guard try await fill() else { break }
            }
        }
        if let tail = try decoder?.finish(), !tail.isEmpty { emit(tail) }
    }

    private func readLine() async throws -> String {
        while buffer.range(of: Self.crlf) == nil {
            guard buffer.count < 16 * 1024 else { throw NappFetch.Refused("Malformed chunk") }
            guard try await fill() else { throw NappFetch.Refused("The response ended early") }
        }
        let end = buffer.range(of: Self.crlf)!
        let line = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
        buffer = Data(buffer[end.upperBound...])
        return line
    }

    private func readChunked(_ deliver: (Data) throws -> Void) async throws {
        while true {
            let sizeText = try await readLine().split(separator: ";").first.map(String.init) ?? ""
            guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16), size >= 0 else {
                throw NappFetch.Refused("Malformed chunk")
            }
            if size == 0 {
                // Trailers, which nobody is given, then the blank line.
                while try await !readLine().isEmpty {}
                return
            }
            var left = size
            while left > 0 {
                if buffer.isEmpty {
                    guard try await fill() else { throw NappFetch.Refused("The response ended early") }
                }
                let take = min(left, buffer.count)
                let piece = Data(buffer.prefix(take))
                buffer.removeFirst(take)
                left -= take
                try deliver(piece)
            }
            _ = try await readLine()
        }
    }
}

/// A gzip or zlib body, for a server that sent one after being asked not to.
final class NappInflater {
    private let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    private var ready = false
    /// gzip's own header, gathered until it can be skipped.
    private var header: Data?
    /// zlib's two-byte header, likewise.
    private var zlibHeader: Int

    init(gzip: Bool) {
        header = gzip ? Data() : nil
        zlibHeader = gzip ? 0 : 2
    }

    deinit {
        if ready { compression_stream_destroy(stream) }
        stream.deallocate()
    }

    func push(_ data: Data) throws -> Data {
        var input = data
        if var pending = header {
            pending.append(input)
            guard let skip = Self.gzipHeaderLength(pending) else {
                header = pending
                return Data()
            }
            header = nil
            input = Data(pending.dropFirst(skip))
        }
        if zlibHeader > 0 {
            let skip = min(zlibHeader, input.count)
            zlibHeader -= skip
            input = Data(input.dropFirst(skip))
        }
        return try process(input, finish: false)
    }

    func finish() throws -> Data {
        try process(Data(), finish: true)
    }

    private func process(_ input: Data, finish: Bool) throws -> Data {
        if !ready {
            guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
                throw NappFetch.Refused("Could not decode the response")
            }
            ready = true
        }
        var out = Data()
        let size = 64 * 1024
        let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { destination.deallocate() }
        let flags = finish ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0

        try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let source = raw.bindMemory(to: UInt8.self)
            stream.pointee.src_ptr = source.baseAddress ?? UnsafePointer(destination)
            stream.pointee.src_size = source.count
            while true {
                stream.pointee.dst_ptr = destination
                stream.pointee.dst_size = size
                let status = compression_stream_process(stream, flags)
                guard status != COMPRESSION_STATUS_ERROR else { throw NappFetch.Refused("Could not decode the response") }
                out.append(destination, count: size - stream.pointee.dst_size)
                if status == COMPRESSION_STATUS_END { break }
                // Done with this input once it is all taken and the output
                // did not fill up.
                if stream.pointee.src_size == 0 && stream.pointee.dst_size > 0 { break }
            }
        }
        return out
    }

    private static func gzipHeaderLength(_ data: Data) -> Int? {
        let bytes = [UInt8](data.prefix(1024))
        guard bytes.count >= 10 else { return nil }
        let flags = bytes[3]
        var at = 10
        if flags & 0x04 != 0 {
            guard bytes.count >= at + 2 else { return nil }
            at += 2 + Int(bytes[at]) + Int(bytes[at + 1]) << 8
        }
        for bit: UInt8 in [0x08, 0x10] where flags & bit != 0 {
            while at < bytes.count, bytes[at] != 0 { at += 1 }
            guard at < bytes.count else { return nil }
            at += 1
        }
        if flags & 0x02 != 0 { at += 2 }
        return bytes.count >= at ? at : nil
    }
}

// MARK: - Policy

/**
 What a site may ask for and where it may go. The same rules as
 `NappFetchPolicy.java`, which says why each is there.
 */
enum NappFetchPolicy {

    /// The notification extension has sixty-five megabytes for everything,
    /// so a worker there gets less room than a window does.
    private static let inExtension = Bundle.main.bundleURL.pathExtension == "appex"

    static let maxBodyBytes = inExtension ? 4 * 1024 * 1024 : 16 * 1024 * 1024
    static let maxResponseBytes = inExtension ? 8 * 1024 * 1024 : 64 * 1024 * 1024
    static let maxRedirects = 5
    static let maxInFlightPerSite = 8
    static let ticketTTL: TimeInterval = 30
    static let headersTimeout: TimeInterval = 30

    static func refuse(url: URL) -> String? {
        guard url.scheme?.lowercased() == "https" else { return "Only https URLs can be fetched" }
        guard url.user == nil, url.password == nil else { return "Credentials in the URL are not allowed" }
        guard let host = url.host, !host.isEmpty else { return "No host" }
        return refuse(host: host)
    }

    static func refuse(host: String) -> String? {
        var lower = host.lowercased()
        if lower.hasPrefix("["), lower.hasSuffix("]") { lower = String(lower.dropFirst().dropLast()) }
        if lower.hasSuffix(".") { lower = String(lower.dropLast()) }

        if lower == "localhost" || lower.hasSuffix(".localhost") { return "That host is not reachable" }
        for suffix in [".local", ".internal", ".home.arpa", ".onion"] where lower.hasSuffix(suffix) {
            return "That host is not reachable"
        }
        if let v4 = IPv4Address(lower), refuse(address: [UInt8](v4.rawValue)) != nil {
            return "That host is not reachable"
        }
        if let v6 = IPv6Address(lower), refuse(address: [UInt8](v6.rawValue)) != nil {
            return "That host is not reachable"
        }
        // The older spellings of an IPv4 address — a bare number, fewer than
        // four parts — which `IPv4Address` does not read and a resolver might.
        if lower.allSatisfy({ $0.isNumber || $0 == "." || $0 == "x" }),
           lower.first?.isNumber == true, IPv4Address(lower) == nil {
            return "That host is not reachable"
        }
        return nil
    }

    static func refuse(address bytes: [UInt8]) -> String? {
        if bytes.count == 4 {
            let a = bytes[0], b = bytes[1]
            if a == 0 { return "Unroutable address" }
            if a == 127 { return "Unroutable address" }
            if a == 10 { return "Private address" }
            if a == 172, (16...31).contains(b) { return "Private address" }
            if a == 192, b == 168 { return "Private address" }
            if a == 169, b == 254 { return "Unroutable address" }
            if a == 100, (64...127).contains(b) { return "Private address" }
            if a == 192, b == 0, bytes[2] == 0 { return "Unroutable address" }
            if a == 198, b == 18 || b == 19 { return "Unroutable address" }
            if a >= 224 { return "Unroutable address" }
            return nil
        }
        guard bytes.count == 16 else { return "Unroutable address" }
        if bytes.allSatisfy({ $0 == 0 }) { return "Unroutable address" }
        if bytes[0..<15].allSatisfy({ $0 == 0 }), bytes[15] == 1 { return "Unroutable address" }
        if bytes[0] & 0xfe == 0xfc { return "Private address" }
        if bytes[0] == 0xfe, bytes[1] & 0xc0 == 0x80 { return "Unroutable address" }
        if bytes[0] == 0xfe, bytes[1] & 0xc0 == 0xc0 { return "Private address" }
        if bytes[0] == 0xff { return "Unroutable address" }
        // An IPv4 address in an IPv6 coat: mapped, compatible, or NAT64's.
        if bytes[0..<10].allSatisfy({ $0 == 0 }), bytes[10] == 0xff, bytes[11] == 0xff {
            return refuse(address: Array(bytes[12..<16]))
        }
        if bytes[0..<12].allSatisfy({ $0 == 0 }) { return refuse(address: Array(bytes[12..<16])) }
        if bytes[0..<12] == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0][...] {
            return refuse(address: Array(bytes[12..<16]))
        }
        return nil
    }

    private static let forbiddenRequestHeaders: Set<String> = [
        "accept-encoding", "connection", "content-length", "cookie", "cookie2", "date", "expect",
        "forwarded", "host", "keep-alive", "origin", "referer", "te", "trailer", "transfer-encoding",
        "upgrade", "via",
    ]
    private static let forbiddenRequestPrefixes = ["proxy-", "sec-", "x-forwarded-", "access-control-request-"]

    static func isForbiddenRequestHeader(_ name: String) -> Bool {
        let lower = name.lowercased()
        guard !lower.isEmpty, lower.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f
            && !"()<>@,;:\\\"/[]?={}".unicodeScalars.contains($0) }) else { return true }
        if forbiddenRequestHeaders.contains(lower) { return true }
        return forbiddenRequestPrefixes.contains { lower.hasPrefix($0) }
    }

    static func isValidHeaderValue(_ value: String) -> Bool {
        !value.contains("\r") && !value.contains("\n") && !value.contains("\0")
    }

    private static let strippedResponseHeaders: Set<String> = [
        "connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate",
        "set-cookie", "set-cookie2", "te", "trailer", "transfer-encoding", "upgrade",
    ]

    static func isStrippedResponseHeader(_ name: String) -> Bool {
        strippedResponseHeaders.contains(name.lowercased())
    }

    private static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

    static func normalize(method: String?) -> String? {
        guard let method, !method.isEmpty else { return "GET" }
        let upper = method.uppercased()
        return methods.contains(upper) ? upper : nil
    }

    static func allowsBody(_ method: String) -> Bool { method != "GET" && method != "HEAD" }

    static func isRedirect(_ status: Int) -> Bool { [301, 302, 303, 307, 308].contains(status) }

    static func redirectBecomesGet(status: Int, method: String) -> Bool {
        if status == 303 { return method != "HEAD" }
        if status == 301 || status == 302 { return method != "GET" && method != "HEAD" }
        return false
    }

    static func isServable(status: Int) -> Bool { (100...599).contains(status) }

    static func isBodiless(status: Int) -> Bool { [204, 205, 304].contains(status) }
}

// MARK: - The route

/**
 The same-origin path a staged request is collected from, and how its answer
 is written into a `WKURLSchemeTask`. Shared by a site's window
 (`NsiteSchemeHandler`) and its worker (`NsiteWorkerHost`).

 A failure a browser would report by rejecting comes back as a response
 carrying `X-Napp-Error`, which the provider turns back into a `TypeError`.
 Once the headers have gone out there is no taking them back, so a failure
 after that fails the task, and the site's read of the body rejects.
 */
@MainActor
enum NappFetchRoute {

    static let path = "/.napp/fetch"

    static func ticket(in url: URL) -> String {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "t" }?.value ?? ""
    }

    static func sink(url: URL, task: @escaping () -> WKURLSchemeTask?, done: @escaping () -> Void) -> NappFetch.Sink {
        var started = false
        return NappFetch.Sink(
            head: { status, headers in
                guard let current = task() else { return }
                var fields = headers
                fields["Cache-Control"] = "no-store"
                guard let response = HTTPURLResponse(url: url, statusCode: status,
                                                     httpVersion: "HTTP/1.1", headerFields: fields) else { return }
                started = true
                current.didReceive(response)
            },
            data: { chunk in
                task()?.didReceive(chunk)
            },
            finish: {
                task()?.didFinish()
                done()
            },
            fail: { message in
                if started {
                    task()?.didFailWithError(URLError(.networkConnectionLost))
                } else {
                    fail(task(), url: url, message: message)
                }
                done()
            }
        )
    }

    static func fail(_ task: WKURLSchemeTask?, url: URL, message: String) {
        guard let task else { return }
        let clean = message.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        guard let response = HTTPURLResponse(url: url, statusCode: 502, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Napp-Error": clean,
        ]) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(Data(clean.utf8))
        task.didFinish()
    }
}
