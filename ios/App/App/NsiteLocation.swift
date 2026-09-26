import CoreLocation
import Foundation

/**
 `navigator.geolocation` for a site, answered by CoreLocation.

 The iOS half of the location section of `NsiteChromeClient.java`, and it has
 to be built rather than configured. WebKit's own geolocation answers through a
 prompt of its own, keyed by origin and remembered where Tenna cannot see it —
 the same trap Android's `retain` flag is. The only public hook iOS gives an
 app is the one for the camera and the microphone; there is none for
 location. So the site is handed a `navigator.geolocation` of Tenna's, before
 any of its own code runs, and every question it asks comes here.

 Which means the two questions are asked in the order Android asks them:
 whether the *site* may know where the user is, on the same sheet a signing
 request opens, and only then whether *Tenna* may, which is the system's
 prompt. There is no point putting the second in front of someone who has not
 yet answered the first.

 Main frame only, like the rest of the bridge. A frame inside the site is
 somebody else's document and gets whatever WebKit gives it, which without a
 prompt of WebKit's own is an error.
 */
@MainActor
final class NsiteLocation: NSObject, CLLocationManagerDelegate {

    /// The script message handler the shim posts to.
    static let handlerName = "tennaLocation"

    /// Error codes, as `GeolocationPositionError` numbers them.
    private enum Failure: Int {
        case permissionDenied = 1
        case positionUnavailable = 2
    }

    private let manager = CLLocationManager()

    /// Whether the site may know, asked of the web layer.
    private let askSite: (@escaping (Bool) -> Void) -> Void

    /// A reply for the shim, as JSON text.
    private let deliver: (String) -> Void

    /// Answers waiting on the system prompt.
    private var authorizing: [(Bool) -> Void] = []

    /// One-shot requests waiting on the next fix.
    private var pending: [Int] = []

    /// Watches that are running, and whether each asked for high accuracy.
    private var watches: [Int: Bool] = [:]

    /// Watches the site has asked for and not yet cleared, answered or not.
    private var live: Set<Int> = []

    /// Whether a one-shot request asked for high accuracy.
    private var pendingHigh = false

    private var closed = false

    init(
        askSite: @escaping (@escaping (Bool) -> Void) -> Void,
        deliver: @escaping (String) -> Void
    ) {
        self.askSite = askSite
        self.deliver = deliver
        super.init()
        manager.delegate = self
    }

    // MARK: - From the page

    func receive(_ body: Any) {
        guard !closed,
              let message = body as? [String: Any],
              let op = message["op"] as? String,
              let id = (message["id"] as? NSNumber)?.intValue else { return }
        let high = message["high"] as? Bool ?? false

        switch op {
        case "clear":
            live.remove(id)
            watches.removeValue(forKey: id)
            updateRunning()

        case "get", "watch":
            let watching = op == "watch"
            if watching { live.insert(id) }

            consent { [weak self] granted in
                guard let self, !self.closed else { return }
                // Cleared while the sheet was up: nobody is listening.
                if watching, !self.live.contains(id) { return }
                guard granted else {
                    self.fail([id], .permissionDenied, "User denied Geolocation")
                    return
                }

                self.authorize { allowed in
                    guard !self.closed else { return }
                    if watching, !self.live.contains(id) { return }
                    guard allowed else {
                        self.fail([id], .permissionDenied, "User denied Geolocation")
                        return
                    }

                    if watching {
                        self.watches[id] = high
                        self.updateRunning()
                        // A fix already in hand, so a watch starts with an
                        // answer rather than waiting for the user to move.
                        if let location = self.manager.location,
                           -location.timestamp.timeIntervalSinceNow < 60 {
                            self.send([id], location)
                        }
                    } else {
                        self.pending.append(id)
                        self.pendingHigh = self.pendingHigh || high
                        self.updateRunning()
                        // `requestLocation` and `startUpdatingLocation` are not
                        // to be mixed. A running watch answers this with its
                        // next fix instead.
                        if self.watches.isEmpty { self.manager.requestLocation() }
                    }
                }
            }

        default:
            return
        }
    }

    /// Stop everything, and never answer again.
    func tearDown() {
        closed = true
        manager.stopUpdatingLocation()
        manager.delegate = nil
        pending.removeAll()
        watches.removeAll()
        live.removeAll()
        authorizing.removeAll()
        consenting = nil
    }

    /**
     Ask the web layer about the site, once for everything asked meanwhile.

     A map commonly asks for a quick fix, a precise one and a watch all at
     once, and three sheets in a row for one tap is two too many. Requests
     made while the sheet is up share its answer; a request after it is gone
     asks again, as Android does.
     */
    private func consent(_ done: @escaping (Bool) -> Void) {
        if consenting != nil {
            consenting?.append(done)
            return
        }
        consenting = [done]
        askSite { [weak self] granted in
            guard let self else { return }
            let waiting = self.consenting ?? []
            self.consenting = nil
            for done in waiting { done(granted) }
        }
    }

    /// Requests waiting on the sheet, or nil if it is not up.
    private var consenting: [(Bool) -> Void]?

    // MARK: - The system's half

    private func authorize(_ done: @escaping (Bool) -> Void) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            done(true)
        case .notDetermined:
            authorizing.append(done)
            if authorizing.count == 1 { manager.requestWhenInUseAuthorization() }
        default:
            done(false)
        }
    }

    /// Run the updates while there is a watch, and at the accuracy asked for.
    private func updateRunning() {
        let high = pendingHigh || watches.values.contains(true)
        manager.desiredAccuracy = high ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters

        if watches.isEmpty {
            manager.stopUpdatingLocation()
        } else {
            manager.startUpdatingLocation()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let status = self.manager.authorizationStatus
            guard status != .notDetermined, !authorizing.isEmpty else { return }
            let allowed = status == .authorizedWhenInUse || status == .authorizedAlways
            let waiting = authorizing
            authorizing.removeAll()
            for done in waiting { done(allowed) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated {
            guard let location = locations.last else { return }
            let ids = pending + Array(watches.keys)
            pending.removeAll()
            pendingHigh = false
            updateRunning()
            if !ids.isEmpty { send(ids, location) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            let code = (error as? CLError)?.code

            if code == .denied {
                let ids = pending + Array(watches.keys)
                pending.removeAll()
                watches.removeAll()
                live.removeAll()
                updateRunning()
                fail(ids, .permissionDenied, "User denied Geolocation")
                return
            }

            // A watch rides out a fix that did not come; CoreLocation keeps
            // trying. A one-shot request has had its one try.
            let ids = pending
            pending.removeAll()
            pendingHigh = false
            fail(ids, .positionUnavailable, "Position unavailable")
        }
    }

    // MARK: - To the page

    private func send(_ ids: [Int], _ location: CLLocation) {
        var coords: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": max(location.horizontalAccuracy, 0),
            "altitude": NSNull(),
            "altitudeAccuracy": NSNull(),
            "heading": NSNull(),
            "speed": NSNull(),
        ]
        if location.verticalAccuracy >= 0 {
            coords["altitude"] = location.altitude
            coords["altitudeAccuracy"] = location.verticalAccuracy
        }
        if location.course >= 0 { coords["heading"] = location.course }
        if location.speed >= 0 { coords["speed"] = location.speed }

        post([
            "ids": ids,
            "position": [
                "coords": coords,
                "timestamp": (location.timestamp.timeIntervalSince1970 * 1000).rounded(),
            ],
        ])
    }

    private func fail(_ ids: [Int], _ failure: Failure, _ message: String) {
        guard !ids.isEmpty else { return }
        post(["ids": ids, "error": ["code": failure.rawValue, "message": message]])
    }

    private func post(_ reply: [String: Any]) {
        guard !closed,
              let data = try? JSONSerialization.data(withJSONObject: reply),
              let text = String(data: data, encoding: .utf8) else { return }
        deliver(text)
    }

    // MARK: - The page's half

    /**
     What the site finds at `navigator.geolocation`.

     Defined on the `navigator` object itself, non-writably, which shadows
     WebKit's getter on the prototype and cannot be put back by the page. The
     reply function is defined the same way. A page calling it directly can
     only lie to itself about where it is.

     `maximumAge` and `timeout` are the page's business and are kept here: the
     last fix is remembered on this side, and a timer that fires first ends the
     request with `TIMEOUT` whatever arrives afterwards.
     */
    static let script = """
    (function() {
      var handler = window.webkit && window.webkit.messageHandlers
        && window.webkit.messageHandlers.\(handlerName);
      if (!handler) return;

      var next = 1;
      var calls = {};
      var last = null;

      function positionError(code, message) {
        return {
          code: code, message: message,
          PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3
        };
      }

      function toPosition(raw) {
        var c = raw.coords;
        var coords = {
          latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy,
          altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
          heading: c.heading, speed: c.speed
        };
        coords.toJSON = function() {
          return {
            latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy,
            altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
            heading: c.heading, speed: c.speed
          };
        };
        var position = { coords: coords, timestamp: raw.timestamp };
        position.toJSON = function() {
          return { coords: coords.toJSON(), timestamp: raw.timestamp };
        };
        return position;
      }

      function invoke(fn, value) {
        if (typeof fn !== 'function') return;
        try { fn(value); } catch (e) { setTimeout(function() { throw e; }); }
      }

      function arm(id, call) {
        clearTimeout(call.timer);
        if (call.timeout === null) return;
        call.timer = setTimeout(function() {
          if (calls[id] !== call) return;
          if (call.op === 'get') delete calls[id];
          invoke(call.failure, positionError(3, 'Timeout expired'));
        }, call.timeout);
      }

      function request(op, success, failure, options) {
        if (typeof success !== 'function') {
          throw new TypeError('Argument 1 is not a function');
        }
        options = options || {};
        var id = next++;

        var maximumAge = Number(options.maximumAge) || 0;
        if (op === 'get' && last && maximumAge > 0
            && Date.now() - last.timestamp <= maximumAge) {
          var cached = last;
          setTimeout(function() { invoke(success, cached); });
          return id;
        }

        var timeout = Number(options.timeout);
        var call = {
          op: op, success: success, failure: failure, timer: null,
          timeout: isFinite(timeout) && timeout >= 0 ? timeout : null
        };
        calls[id] = call;
        arm(id, call);
        handler.postMessage({ op: op, id: id, high: !!options.enableHighAccuracy });
        return id;
      }

      function receive(reply) {
        var position = reply.position ? toPosition(reply.position) : null;
        if (position) last = position;

        reply.ids.forEach(function(id) {
          var call = calls[id];
          if (!call) return;
          clearTimeout(call.timer);

          if (reply.error) {
            if (call.op === 'get' || reply.error.code === 1) delete calls[id];
            else arm(id, call);
            invoke(call.failure, positionError(reply.error.code, reply.error.message));
            return;
          }

          if (call.op === 'get') delete calls[id];
          else arm(id, call);
          invoke(call.success, position);
        });
      }

      var geolocation = {
        getCurrentPosition: function(success, failure, options) {
          request('get', success, failure, options);
        },
        watchPosition: function(success, failure, options) {
          return request('watch', success, failure, options);
        },
        clearWatch: function(id) {
          var call = calls[id];
          if (!call || call.op !== 'watch') return;
          clearTimeout(call.timer);
          delete calls[id];
          handler.postMessage({ op: 'clear', id: id });
        }
      };

      Object.defineProperty(navigator, 'geolocation', {
        value: geolocation, enumerable: true
      });
      Object.defineProperty(window, '__tennaLocationReceive', { value: receive });
    })();
    """
}
