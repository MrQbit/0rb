import SwiftUI

struct ChatView: View {
    @EnvironmentObject var app: AppState
    @State private var messages: [ChatMessage] = []
    @State private var input = ""
    @State private var sending = false
    private let sessionId = "ios:" + UUID().uuidString.prefix(8)

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { m in bubble(m).id(m.id) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.last?.text) { _ in
                    if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            composer
        }
        .background(Theme.background)
    }

    private var header: some View {
        HStack {
            Text("rak").foregroundColor(Theme.text)
            + Text("00").foregroundColor(Theme.nv)
            + Text("n").foregroundColor(Theme.text)
            Spacer()
            Menu {
                Text("Signed in as \(app.username)")
                Button("Sign out", role: .destructive) { app.signOut() }
            } label: {
                Image(systemName: "person.crop.circle").foregroundStyle(Theme.nv)
            }
        }
        .font(.headline).padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.panel.opacity(0.7))
    }

    private func bubble(_ m: ChatMessage) -> some View {
        HStack {
            if m.role == .user { Spacer(minLength: 40) }
            Text(m.text.isEmpty && m.streaming ? "…" : m.text)
                .foregroundStyle(m.role == .user ? .black : Theme.text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(m.role == .user ? Theme.nv : Theme.panel)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            if m.role == .assistant { Spacer(minLength: 40) }
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Message orb2…", text: $input, axis: .vertical)
                .lineLimit(1...4)
                .padding(12).background(Theme.panel)
                .foregroundStyle(Theme.text)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(input.isEmpty || sending ? Theme.muted : Theme.nv)
            }
            .disabled(input.isEmpty || sending)
        }
        .padding(12).background(Theme.panel.opacity(0.5))
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""; sending = true
        messages.append(ChatMessage(role: .user, text: text))
        messages.append(ChatMessage(role: .assistant, text: "", streaming: true))
        let idx = messages.count - 1

        Task {
            do {
                _ = try await APIClient.chatStream(message: text, sessionId: String(sessionId)) { chunk in
                    Task { @MainActor in messages[idx].text += chunk }
                }
            } catch {
                await MainActor.run { messages[idx].text = "⚠️ \(error.localizedDescription)" }
            }
            await MainActor.run {
                messages[idx].streaming = false
                sending = false
            }
        }
    }
}
