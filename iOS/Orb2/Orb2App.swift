import SwiftUI

@main
struct Orb2App: App {
    @StateObject private var app = AppState()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .preferredColorScheme(.dark)
                .tint(Theme.nv)
        }
    }
}

/// Global auth/session state.
@MainActor
final class AppState: ObservableObject {
    @Published var isAuthenticated = false
    @Published var username = ""
    @Published var checking = true

    func bootstrap() async {
        guard AppConfig.httpBase() != nil, AppConfig.sessionToken != nil else {
            checking = false; isAuthenticated = false; return
        }
        if let me = await APIClient.me(), me.authenticated {
            isAuthenticated = true
            username = me.username ?? ""
        } else {
            isAuthenticated = false
        }
        checking = false
    }

    func signedIn(as name: String) {
        username = name
        isAuthenticated = true
    }

    func signOut() {
        Task { await APIClient.logout() }
        isAuthenticated = false
        username = ""
    }
}
