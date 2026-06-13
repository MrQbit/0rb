import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
    var streaming: Bool = false
}

struct LoginResponse: Decodable {
    let ok: Bool?
    let token: String?
    let username: String?
    let error: String?
}

struct MeResponse: Decodable {
    let authenticated: Bool
    let username: String?
}
