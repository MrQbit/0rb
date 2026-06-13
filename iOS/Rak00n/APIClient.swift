import Foundation

/// Talks to the rak00n API: auth + streaming chat. The session token is sent
/// as a Bearer header (the same token the web console stores in a cookie).
struct APIClient {

    enum APIError: LocalizedError {
        case noServer, badStatus(Int), message(String)
        var errorDescription: String? {
            switch self {
            case .noServer: return "Set your server URL first."
            case .badStatus(let c): return "Server error (\(c))."
            case .message(let m): return m
            }
        }
    }

    private static func url(_ path: String) throws -> URL {
        guard let base = AppConfig.httpBase() else { throw APIError.noServer }
        return base.appendingPathComponent(path)
    }

    private static func authed(_ req: inout URLRequest) {
        if let t = AppConfig.sessionToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
    }

    // MARK: Auth

    /// Sign in; on success the token is persisted. Returns the username.
    @discardableResult
    static func login(username: String, password: String) async throws -> String {
        var req = URLRequest(url: try url("/v1/auth/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
        let (data, resp) = try await URLSession.shared.data(for: req)
        let decoded = try? JSONDecoder().decode(LoginResponse.self, from: data)
        guard (resp as? HTTPURLResponse)?.statusCode == 200, let d = decoded, d.ok == true else {
            throw APIError.message(decoded?.error ?? "Invalid credentials")
        }
        if let token = d.token { AppConfig.sessionToken = token }
        return d.username ?? username
    }

    static func me() async -> MeResponse? {
        guard let u = try? url("/v1/auth/me") else { return nil }
        var req = URLRequest(url: u); authed(&req)
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return try? JSONDecoder().decode(MeResponse.self, from: data)
    }

    static func logout() async {
        AppConfig.sessionToken = nil
        guard let u = try? url("/v1/auth/logout") else { return }
        var req = URLRequest(url: u); req.httpMethod = "POST"; authed(&req)
        _ = try? await URLSession.shared.data(for: req)
    }

    // MARK: Chat (SSE stream)

    /// Stream a chat turn. `onChunk` is called with incremental text;
    /// returns the final full text.
    @discardableResult
    static func chatStream(
        message: String,
        sessionId: String,
        onChunk: @escaping (String) -> Void
    ) async throws -> String {
        var req = URLRequest(url: try url("/v1/chat/stream"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        authed(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: ["message": message, "sessionId": sessionId])

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.badStatus(0) }
        guard http.statusCode == 200 else { throw APIError.badStatus(http.statusCode) }

        var full = ""
        var event = ""
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let json = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                guard let data = json.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                if event == "done" {
                    if let ft = obj["full_text"] as? String, !ft.isEmpty { full = ft }
                    break
                } else if let t = obj["text"] as? String {   // text_chunk
                    full += t
                    onChunk(t)
                }
            }
        }
        return full
    }
}
