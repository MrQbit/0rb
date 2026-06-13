import SwiftUI

struct LoginView: View {
    @EnvironmentObject var app: AppState
    @State private var server = AppConfig.baseURL
    @State private var username = ""
    @State private var password = ""
    @State private var error = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 18) {
            HStack(spacing: 10) {
                Image(systemName: "pawprint.circle.fill")
                    .font(.system(size: 38)).foregroundStyle(Theme.nv)
                Text("rak").foregroundColor(Theme.text)
                + Text("00").foregroundColor(Theme.nv)
                + Text("n").foregroundColor(Theme.text)
            }
            .font(.system(size: 30, weight: .bold))

            Text("Sign in to your agent")
                .font(.subheadline).foregroundStyle(Theme.muted)

            VStack(spacing: 12) {
                field("Server URL", text: $server, placeholder: "https://host.tailnet.ts.net", keyboard: .URL)
                field("Username", text: $username, placeholder: "rak00n")
                secureField("Password", text: $password)
            }

            if !error.isEmpty {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }

            Button(action: signIn) {
                HStack {
                    if busy { ProgressView().tint(.black) }
                    Text("Sign in").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(Theme.nv).foregroundStyle(.black)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(busy)
        }
        .padding(26)
        .background(Theme.panel.opacity(0.85))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.nv.opacity(0.18)))
        .padding(24)
    }

    private func signIn() {
        error = ""; busy = true
        AppConfig.baseURL = server
        Task {
            do {
                let name = try await APIClient.login(username: username, password: password)
                await MainActor.run { app.signedIn(as: name) }
            } catch {
                await MainActor.run { self.error = error.localizedDescription }
            }
            await MainActor.run { busy = false }
        }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String = "",
                       keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased()).font(.caption2).foregroundStyle(Theme.muted)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(keyboard)
                .padding(12).background(Color.black.opacity(0.35))
                .foregroundStyle(Theme.text)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func secureField(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased()).font(.caption2).foregroundStyle(Theme.muted)
            SecureField("", text: text)
                .padding(12).background(Color.black.opacity(0.35))
                .foregroundStyle(Theme.text)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}
