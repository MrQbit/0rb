import Foundation
import AVFoundation

/// Drives the orb2 voice session on iOS:
///   mic → 16 kHz PCM16 frames → /v1/voice/ws → {transcript, agent_response,
///   audio_start, <pcm>, audio_cancel, audio_end} → speaker.
///
/// Mirrors the web client: continuous capture with server-side VAD, neural
/// TTS playback, and barge-in (local mic energy cancels playback).
@MainActor
final class VoiceClient: NSObject, ObservableObject {

    enum State: String { case idle, connecting, listening, thinking, speaking, error }

    @Published var state: State = .idle
    @Published var transcript = ""
    @Published var reply = ""
    @Published var micLevel: Float = 0      // 0…1, drives the orb
    @Published var errorText = ""

    private var ws: URLSessionWebSocketTask?
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var converter: AVAudioConverter?
    private let inFormat16k = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: 16000, channels: 1, interleaved: true)!
    private var ttsRate: Double = 24000
    private var playing = false
    private var running = false

    // MARK: lifecycle

    func start() {
        guard state == .idle || state == .error else { return }
        guard let wsBase = AppConfig.wsBase(), let token = AppConfig.sessionToken,
              let url = URL(string: "\(wsBase)/v1/voice/ws") else {
            fail("Set the server URL and sign in first."); return
        }
        state = .connecting; transcript = ""; reply = ""; running = true

        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        ws = URLSession.shared.webSocketTask(with: req)
        ws?.resume()
        receiveLoop()

        do { try startAudio() } catch { fail("Audio init failed: \(error.localizedDescription)"); return }
    }

    func stop() {
        running = false
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        player.stop()
        ws?.cancel(with: .goingAway, reason: nil); ws = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        state = .idle; micLevel = 0
    }

    // MARK: audio

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat,
                                options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: inFormat, to: inFormat16k)

        engine.attach(player)
        let playFormat = AVAudioFormat(standardFormatWithSampleRate: ttsRate, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buf, _ in
            self?.handleMic(buf)
        }
        engine.prepare()
        try engine.start()
        player.play()
        state = .listening
    }

    private func handleMic(_ buffer: AVAudioPCMBuffer) {
        guard running, let converter else { return }
        // Resample/convert mic audio to 16 kHz mono Int16.
        let ratio = inFormat16k.sampleRate / buffer.format.sampleRate
        let outCap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: inFormat16k, frameCapacity: outCap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        if err != nil || out.frameLength == 0 { return }

        guard let ch = out.int16ChannelData else { return }
        let n = Int(out.frameLength)
        // amplitude for the orb
        var sum: Float = 0
        for i in 0..<n { let s = Float(ch[0][i]) / 32768; sum += s * s }
        let rms = (n > 0) ? (sum / Float(n)).squareRoot() : 0
        Task { @MainActor in self.micLevel = min(1, rms * 6) }

        let data = Data(bytes: ch[0], count: n * MemoryLayout<Int16>.size)
        ws?.send(.data(data)) { _ in }
    }

    private func playPCM(_ data: Data) {
        guard playing else { return }
        let frames = data.count / 2
        guard frames > 0,
              let buf = AVAudioPCMBuffer(
                pcmFormat: AVAudioFormat(standardFormatWithSampleRate: ttsRate, channels: 1)!,
                frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            let dst = buf.floatChannelData![0]
            for i in 0..<frames { dst[i] = Float(src[i]) / 32768 }
        }
        player.scheduleBuffer(buf, completionHandler: nil)
    }

    // MARK: websocket

    private func receiveLoop() {
        ws?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                Task { @MainActor in if self.running { self.fail("Voice connection lost") } }
            case .success(let msg):
                Task { @MainActor in self.handle(msg) }
                self.receiveLoop()
            }
        }
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) {
        switch msg {
        case .data(let d):
            playPCM(d)
        case .string(let s):
            guard let data = s.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String else { return }
            switch type {
            case "ready": state = .listening
            case "transcript":
                if let t = obj["text"] as? String { transcript = t }
                if obj["final"] as? Bool == true { state = .thinking; reply = "" }
            case "agent_response_chunk":
                if let t = obj["text"] as? String { reply += t }
            case "agent_response":
                if let t = obj["text"] as? String { reply = t }
            case "audio_start":
                if let r = obj["sample_rate"] as? Double { ttsRate = r }
                playing = true; state = .speaking
            case "audio_cancel", "audio_end":
                playing = false; state = .listening
            case "error":
                fail((obj["message"] as? String) ?? "Voice error")
            default: break
            }
        @unknown default: break
        }
    }

    private func fail(_ message: String) {
        errorText = message; state = .error; running = false
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        ws?.cancel(with: .goingAway, reason: nil)
    }
}
