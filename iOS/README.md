# orb2 — iOS app

A native SwiftUI client for your orb2 agent, with the same NVIDIA-green
identity, sign-in, streaming chat, and **voice** (the audio-reactive orb,
mic streaming, and spoken replies) as the web console.

It talks to the same API as the website — login (`/v1/auth/login`),
streaming chat (`/v1/chat/stream`), and the voice WebSocket
(`/v1/voice/ws`) — authenticating with the session token as a Bearer.

## Build it (Xcode, on a Mac)

This folder is plain Swift source so you can drop it into a fresh project:

1. Xcode → **New → Project → iOS → App**. Product name **Orb2**,
   Interface **SwiftUI**, Language **Swift**. (Or open this `iOS/` folder
   and add a target.)
2. Delete the generated `ContentView.swift`, then **drag the `Orb2/`
   folder's `.swift` files** into the project (check "Copy items if needed").
3. In the target's **Info** tab add:
   - `NSMicrophoneUsageDescription` = "orb2 uses the microphone for voice."
   - (If pointing at an `http://` server) **App Transport Security** →
     allow arbitrary loads, or better: use the Tailscale **https** URL.
4. Set the deployment target to **iOS 16+**.
5. Run on a device (voice needs a real device mic; the simulator can do
   text chat).

## Configure the server

On first launch, set your server URL on the **sign-in** screen — e.g.
your Tailscale HTTPS address `https://<machine>.<tailnet>.ts.net`
(recommended — voice needs HTTPS off-device) or `http://<host>:9080` on
your LAN. It's remembered. Then sign in with your console credentials.

## Files
- `Orb2App.swift` — entry point + app state
- `Theme.swift` — colors / identity
- `AppConfig.swift` — server URL persistence
- `APIClient.swift` — auth + streaming chat
- `Models.swift` — shared types
- `RootView.swift` — login gate
- `LoginView.swift` — sign in + server URL
- `ChatView.swift` — streaming text chat
- `VoiceView.swift` — the orb + voice session UI
- `VoiceClient.swift` — mic capture (16 kHz PCM) ↔ voice WebSocket ↔ playback
