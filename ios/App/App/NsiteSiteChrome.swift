import UIKit

/**
 What the site's own document says about the frame around it.

 A regex sniffer, not a parser, and deliberately so: the two things worth
 knowing are both in the head, both in meta tags, and both needed before the
 renderer paints a byte — so the document is read on the serving thread rather
 than asked for afterwards with `evaluateJavaScript`, which would arrive a
 frame late and show the site jumping into place.

 Narrower than `NsiteSiteChrome.java` on purpose. Android reads `theme-color`
 to decide whether the clock and gesture pill are drawn black or white over
 the site, because there the site fills the window and owns the status bar.
 Here it is inset below Tenna's own bar and owns neither, so the colour is only
 ever the letterbox behind a site that did not ask to draw edge to edge.
 */
struct NsiteSiteChrome {

    /// Whether the site asked to draw under the system bars.
    let edgeToEdge: Bool

    /// Declarations in document order, first match winning.
    private let themeColors: [Declaration]

    private struct Declaration {
        let color: UIColor
        /// nil for an unconditional declaration.
        let prefersDark: Bool?
    }

    /**
     The colour the site says the frame around it should be, or nothing.

     First match wins, which is what the HTML standard asks for: a document
     that names a dark colour before an unconditional one is naming the dark
     one for a dark device. Nothing at all is a real answer — a site whose only
     declaration is keyed on the scheme the device isn't in has said nothing
     about the scheme it is in, and guessing from the other one would be
     inventing a colour the site never asked for.
     */
    func themeColor(prefersDark: Bool) -> UIColor? {
        for declaration in themeColors {
            if declaration.prefersDark == nil || declaration.prefersDark == prefersDark {
                return declaration.color
            }
        }
        return nil
    }

    static let empty = NsiteSiteChrome(edgeToEdge: false, themeColors: [])

    // -----------------------------------------------------------------------

    /// Only the head can carry a viewport meta, and it is the top of the file.
    private static let sniffLimit = 64 * 1024

    private static let metaTag = try! NSRegularExpression(
        pattern: "<meta\\b[^>]*>", options: [.caseInsensitive])

    private static let viewportFitCover = try! NSRegularExpression(
        pattern: "viewport-fit\\s*=\\s*cover", options: [.caseInsensitive])

    /// The one media query worth evaluating without a CSS engine behind it.
    private static let prefersColorScheme = try! NSRegularExpression(
        pattern: "^\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)$",
        options: [.caseInsensitive])

    static func read(_ html: String) -> NsiteSiteChrome {
        let head = html.count > sniffLimit ? String(html.prefix(sniffLimit)) : html
        let range = NSRange(head.startIndex..<head.endIndex, in: head)

        var edgeToEdge = false
        var themeColors: [Declaration] = []

        for match in metaTag.matches(in: head, range: range) {
            guard let tagRange = Range(match.range, in: head) else { continue }
            let tag = String(head[tagRange])
            guard let name = attribute(tag, "name") else { continue }

            if name.caseInsensitiveCompare("viewport") == .orderedSame {
                if let content = attribute(tag, "content") {
                    let r = NSRange(content.startIndex..<content.endIndex, in: content)
                    if viewportFitCover.firstMatch(in: content, range: r) != nil {
                        edgeToEdge = true
                    }
                }
            } else if name.caseInsensitiveCompare("theme-color") == .orderedSame {
                guard let color = parseColor(attribute(tag, "content")) else { continue }

                guard let media = attribute(tag, "media") else {
                    themeColors.append(Declaration(color: color, prefersDark: nil))
                    continue
                }

                let trimmed = media.trimmingCharacters(in: .whitespaces)
                let r = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
                // Anything else is a query with no answer here, and a
                // declaration that can't be evaluated can't be honoured.
                if let m = prefersColorScheme.firstMatch(in: trimmed, range: r),
                   let g = Range(m.range(at: 1), in: trimmed) {
                    let dark = trimmed[g].caseInsensitiveCompare("dark") == .orderedSame
                    themeColors.append(Declaration(color: color, prefersDark: dark))
                }
            }
        }

        return NsiteSiteChrome(edgeToEdge: edgeToEdge, themeColors: themeColors)
    }

    /// Read an attribute out of a single tag, quoted either way or bare.
    private static func attribute(_ tag: String, _ attribute: String) -> String? {
        let pattern = "\(attribute)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))"
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        else { return nil }

        let range = NSRange(tag.startIndex..<tag.endIndex, in: tag)
        guard let m = re.firstMatch(in: tag, range: range) else { return nil }

        for group in 1...3 {
            if let r = Range(m.range(at: group), in: tag) {
                return String(tag[r]).trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    /**
     Parse a `theme-color`, or nothing.

     The value comes from a Nostr event and ends up as a view's background, so
     it is matched against known syntaxes rather than handed to a lenient
     parser. Hex and `rgb()`/`rgba()` cover everything the iframe path accepts
     bar `hsl()` and the CSS keywords; a site using either gets the plain black
     letterbox. That is a fallback, not a failure.
     */
    static func parseColor(_ value: String?) -> UIColor? {
        guard let value else { return nil }
        let color = value.trimmingCharacters(in: .whitespaces)

        if color.hasPrefix("#") { return parseHex(String(color.dropFirst())) }

        let lower = color.lowercased()
        if lower.hasPrefix("rgb(") || lower.hasPrefix("rgba(") {
            guard let open = color.firstIndex(of: "("), color.hasSuffix(")") else { return nil }
            let inner = String(color[color.index(after: open)..<color.index(before: color.endIndex)])
            guard !inner.contains("(") else { return nil }
            return parseRgb(inner)
        }

        return nil
    }

    private static func parseHex(_ digits: String) -> UIColor? {
        let hex = digits.lowercased()
        guard hex.allSatisfy({ $0.isHexDigit }) else { return nil }

        func expand(_ c: Character) -> String { String(repeating: c, count: 2) }

        let pairs: [String]
        switch hex.count {
        case 3, 4:
            pairs = hex.map(expand)
        case 6, 8:
            pairs = stride(from: 0, to: hex.count, by: 2).map { i in
                let start = hex.index(hex.startIndex, offsetBy: i)
                return String(hex[start..<hex.index(start, offsetBy: 2)])
            }
        default:
            return nil
        }

        let values = pairs.compactMap { UInt8($0, radix: 16) }
        guard values.count == pairs.count else { return nil }

        let alpha = values.count == 4 ? CGFloat(values[3]) / 255 : 1
        return UIColor(
            red: CGFloat(values[0]) / 255,
            green: CGFloat(values[1]) / 255,
            blue: CGFloat(values[2]) / 255,
            alpha: alpha
        )
    }

    /// `rgb()` and `rgba()`, in both the comma and the space syntax.
    private static func parseRgb(_ inner: String) -> UIColor? {
        let normalised = inner.replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: ",", with: " ")
        let parts = normalised.split(whereSeparator: \.isWhitespace).map(String.init)
        guard parts.count == 3 || parts.count == 4 else { return nil }

        func channel(_ text: String) -> CGFloat? {
            if text.hasSuffix("%") {
                guard let pct = Double(text.dropLast()) else { return nil }
                return CGFloat(min(max(pct / 100, 0), 1))
            }
            guard let raw = Double(text) else { return nil }
            return CGFloat(min(max(raw / 255, 0), 1))
        }

        guard let r = channel(parts[0]),
              let g = channel(parts[1]),
              let b = channel(parts[2]) else { return nil }

        var alpha: CGFloat = 1
        if parts.count == 4 {
            let text = parts[3]
            if text.hasSuffix("%") {
                guard let pct = Double(text.dropLast()) else { return nil }
                alpha = CGFloat(min(max(pct / 100, 0), 1))
            } else {
                guard let raw = Double(text) else { return nil }
                alpha = CGFloat(min(max(raw, 0), 1))
            }
        }

        return UIColor(red: r, green: g, blue: b, alpha: alpha)
    }
}
