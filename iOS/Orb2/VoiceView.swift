import SwiftUI

struct VoiceView: View {
    @StateObject private var voice = VoiceClient()
    @State private var pulse = false

    var body: some View {
        ZStack {
            Theme.background
            VStack(spacing: 28) {
                Spacer()
                orb
                Text(statusText)
                    .font(.headline).foregroundStyle(Theme.nv)
                    .animation(.default, value: voice.state)

                VStack(spacing: 8) {
                    if !voice.transcript.isEmpty {
                        Text(voice.transcript).foregroundStyle(Theme.text)
                            .multilineTextAlignment(.center)
                    }
                    if !voice.reply.isEmpty {
                        Text(voice.reply).foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                    }
                    if !voice.errorText.isEmpty {
                        Text(voice.errorText).foregroundStyle(Theme.danger)
                    }
                }
                .padding(.horizontal, 28).frame(minHeight: 60)

                Spacer()
                button
                Spacer().frame(height: 20)
            }
        }
    }

    // Audio-reactive orb: radius/glow scale with mic level; color tracks state.
    private var orb: some View {
        let level = CGFloat(voice.micLevel)
        let base: CGFloat = 120
        let size = base + level * 60
        return ZStack {
            Circle()
                .fill(orbColor.opacity(0.18))
                .frame(width: size + 70, height: size + 70)
                .blur(radius: 24)
            Circle()
                .fill(RadialGradient(colors: [orbColor, orbColor.opacity(0.25)],
                                     center: .center, startRadius: 4, endRadius: size/1.6))
                .frame(width: size, height: size)
                .overlay(Circle().stroke(orbColor.opacity(0.7), lineWidth: 2))
                .scaleEffect(pulse ? 1.04 : 0.98)
                .shadow(color: orbColor.opacity(0.6), radius: 24)
        }
        .animation(.easeInOut(duration: 0.12), value: voice.micLevel)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { pulse = true }
        }
    }

    private var button: some View {
        let active = voice.state != .idle && voice.state != .error
        return Button {
            active ? voice.stop() : voice.start()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: active ? "stop.fill" : "mic.fill")
                Text(active ? "End" : "Start voice").fontWeight(.semibold)
            }
            .padding(.horizontal, 26).padding(.vertical, 14)
            .background(active ? Theme.danger : Theme.nv)
            .foregroundStyle(active ? .white : .black)
            .clipShape(Capsule())
        }
    }

    private var orbColor: Color {
        switch voice.state {
        case .thinking: return Theme.nvBright
        case .speaking: return Theme.nv
        case .error:    return Theme.danger
        default:        return Theme.nv
        }
    }

    private var statusText: String {
        switch voice.state {
        case .idle: return "Tap to talk to orb2"
        case .connecting: return "Connecting…"
        case .listening: return "Listening…"
        case .thinking: return "Thinking…"
        case .speaking: return "Speaking…"
        case .error: return "Error"
        }
    }
}
