import Foundation

/// Persists the server base URL and the session token between launches.
enum AppConfig {
    private static let baseKey = "orb2.baseURL"
    private static let tokenKey = "orb2.sessionToken"

    static var baseURL: String {
        get { UserDefaults.standard.string(forKey: baseKey) ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: baseKey) }
    }

    static var sessionToken: String? {
        get { UserDefaults.standard.string(forKey: tokenKey) }
        set { UserDefaults.standard.set(newValue, forKey: tokenKey) }
    }

    /// Normalized base URL (no trailing slash). Empty if unset/invalid.
    static func httpBase() -> URL? {
        let s = baseURL.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, let u = URL(string: s.hasSuffix("/") ? String(s.dropLast()) : s) else { return nil }
        return u
    }

    /// ws(s):// base derived from the http(s):// base, for the voice socket.
    static func wsBase() -> String? {
        guard let u = httpBase(), let scheme = u.scheme else { return nil }
        let wsScheme = scheme == "https" ? "wss" : "ws"
        var s = u.absoluteString
        s = s.replacingOccurrences(of: "\(scheme)://", with: "\(wsScheme)://")
        return s
    }
}
