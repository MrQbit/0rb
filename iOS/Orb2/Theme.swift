import SwiftUI

/// orb2 visual identity — NVIDIA green on near-black, matching the web console.
enum Theme {
    static let nv       = Color(red: 0x76/255, green: 0xb9/255, blue: 0x00/255) // #76b900
    static let nvBright = Color(red: 0x8f/255, green: 0xd4/255, blue: 0x00/255)
    static let nvDim    = Color(red: 0x5a/255, green: 0x8c/255, blue: 0x00/255)
    static let bg       = Color(red: 0x0a/255, green: 0x0d/255, blue: 0x0a/255)
    static let panel    = Color(red: 0x12/255, green: 0x17/255, blue: 0x12/255)
    static let text     = Color(red: 0xe8/255, green: 0xf0/255, blue: 0xe0/255)
    static let muted    = Color(red: 0x7d/255, green: 0x89/255, blue: 0x7a/255)
    static let danger   = Color(red: 0xff/255, green: 0x6b/255, blue: 0x6b/255)

    /// Ambient background gradient used app-wide.
    static var background: some View {
        ZStack {
            bg
            RadialGradient(
                colors: [nv.opacity(0.14), .clear],
                center: .top, startRadius: 10, endRadius: 520
            )
        }
        .ignoresSafeArea()
    }
}
