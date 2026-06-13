import SwiftUI

struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ZStack {
            Theme.background
            if app.checking {
                ProgressView().tint(Theme.nv)
            } else if app.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .task { await app.bootstrap() }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
            VoiceView()
                .tabItem { Label("Voice", systemImage: "waveform") }
        }
        .tint(Theme.nv)
    }
}
