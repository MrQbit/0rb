#!/usr/bin/env python3
"""
Ring voice satellite (SPEC: screenless interaction point #1).

Pipeline: Ring camera mic (RTSP via ring-mqtt/go2rtc) → ffmpeg → 16k PCM →
Vosk keyword spotting ("hey orb") → on wake, stream the utterance to orb's
voice WebSocket (the same protocol the console/apps speak) → orb replies
with TTS PCM (24k) → pushed to the Ring's SPEAKER through go2rtc's
backchannel API. No screen anywhere in the loop.

Idles politely until RING_RTSP is configured (post ring-mqtt auth).
"""
import json, os, subprocess, sys, time, threading, queue, tempfile, wave, urllib.request

WS_URL = os.environ.get("ORB2_VOICE_WS", "ws://127.0.0.1:9084/v1/voice/ws")
TOKEN = os.environ.get("ORB2_VOICE_TOKEN", "")
RTSP = os.environ.get("RING_RTSP", "")
GO2RTC = os.environ.get("GO2RTC_API", "http://127.0.0.1:1984").rstrip("/")
STREAM = os.environ.get("RING_STREAM", "")
WAKE = [w.strip().lower() for w in os.environ.get("WAKE_WORDS", "hey orb,orb").split(",") if w.strip()]

RATE = 16000
CHUNK = 3200                     # 100ms
UTTER_SILENCE_S = 1.2            # end-of-utterance
UTTER_MAX_S = 12

# Self-echo guard (§16): while orb's own reply is playing in the room, the
# camera mic hears it — suppress wake-spotting until playback ends + tail.
suppress_until = 0.0

def log(*a): print("[ringvoice]", *a, flush=True)

def speak_to_ring(pcm24k: bytes):
    """TTS PCM (24k mono s16le) → WAV → go2rtc backchannel → Ring speaker.
    WAVs land in /ringaudio, a volume SHARED with the go2rtc container —
    go2rtc's ffmpeg source resolves the path in its own filesystem."""
    global suppress_until
    suppress_until = time.time() + len(pcm24k) / 48000 + 2.0   # clip + tail
    if not STREAM:
        log("no RING_STREAM set — skipping speaker output"); return
    with tempfile.NamedTemporaryFile(suffix=".wav", dir="/ringaudio", delete=False) as f:
        w = wave.open(f, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(pcm24k); w.close(); path = f.name
    # Preferred rail (§16.4): the `ring_talk` stream — go2rtc's native ring:
    # source, the only path that reaches the camera's own speaker. It exists
    # once two-way audio is enabled in Settings. ring-mqtt's external RTSP
    # (STREAM) is one-way, so with no ring_talk we go straight to the room
    # speaker instead of poking a dead backchannel.
    spoke = False
    try:
        with urllib.request.urlopen(GO2RTC + "/api/streams", timeout=4) as r:
            has_talk = "ring_talk" in json.loads(r.read())
    except Exception:
        has_talk = False
    if has_talk:
        src = f"ffmpeg:{path}#audio=opus"
        url = f"{GO2RTC}/api/streams?dst=ring_talk&src={urllib.parse.quote(src, safe='')}"
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=15).read()
            log("spoke", len(pcm24k) // 48000, "s out the Ring's speaker")
            spoke = True
        except Exception as e:
            log("ring_talk push failed:", e)
    if not spoke:
        speak_to_room(path)
    # give go2rtc time to play before unlink
    threading.Timer(30, lambda: os.unlink(path) if os.path.exists(path) else None).start()

def speak_to_room(wav_path: str):
    """Fallback reply path: POST the TTS WAV to orb, which announces it on
    the nearest AirPlay speaker (same room as the Ring)."""
    api = os.environ.get("ORB2_API", "http://127.0.0.1:9080").rstrip("/")
    speaker = os.environ.get("RING_FALLBACK_SPEAKER", "living room")
    try:
        with open(wav_path, "rb") as f: wav = f.read()
        req = urllib.request.Request(
            f"{api}/v1/ring/speak?speaker={urllib.parse.quote(speaker)}",
            data=wav, method="POST",
            headers={"Content-Type": "audio/wav", "Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            log("room speaker reply:", r.read()[:120].decode(errors="replace"))
    except Exception as e:
        log("room speaker fallback failed:", e)

import urllib.parse

def run_session(utterance_pcm: bytes):
    """One wake → utterance → orb → speaker round trip."""
    import websocket
    hdr = [f"Authorization: Bearer {TOKEN}"] if TOKEN else []
    tts = bytearray(); done = threading.Event(); reply = {"text": ""}
    def on_msg(ws, msg):
        if isinstance(msg, bytes): tts.extend(msg); return
        try: d = json.loads(msg)
        except Exception: return
        t = d.get("type")
        if t == "transcript" and d.get("final"): log("heard:", d.get("text"))
        elif t == "agent_response": reply["text"] = d.get("text", ""); log("orb:", reply["text"][:80])
        elif t == "audio_end": done.set()
        elif t == "error": log("orb error:", d.get("message")); done.set()
    def on_open(ws):
        log("ws open — sending utterance", len(utterance_pcm) // (RATE * 2), "s")
        for i in range(0, len(utterance_pcm), CHUNK):
            ws.send(utterance_pcm[i:i+CHUNK], opcode=2)
        # server-side VAD finalizes on silence — append 1.6s of it
        ws.send(b"\x00" * int(RATE * 2 * 1.6), opcode=2)
    ws = websocket.WebSocketApp(WS_URL + "?session=ring-satellite", header=hdr,
                                on_message=on_msg, on_open=on_open)
    th = threading.Thread(target=ws.run_forever, daemon=True); th.start()
    done.wait(timeout=45)
    time.sleep(1.0)              # trailing tts frames
    try: ws.close()
    except Exception: pass
    if tts: speak_to_ring(bytes(tts))

MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))

def discover_mqtt():
    """Find camera device ids from ring-mqtt's topics (ring/<loc>/camera/<id>/…).
    This is the only discovery channel that exists post-auth: ring-mqtt's
    authenticator UI (:55123) shuts down once it holds a token, and its
    embedded go2rtc exposes no API — but MQTT chatters constantly."""
    import paho.mqtt.client as mqtt
    found: set[str] = set()
    done = threading.Event()
    def on_msg(_c, _u, m):
        parts = m.topic.split("/")
        if len(parts) >= 4 and parts[0] == "ring" and parts[2] == "camera":
            found.add(parts[3])
            done.set()
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    c.on_message = on_msg
    c.connect(MQTT_HOST, MQTT_PORT, 30)
    c.subscribe("ring/#")
    c.loop_start()
    done.wait(timeout=90)
    c.loop_stop()
    try: c.disconnect()
    except Exception: pass
    return sorted(found)

def register_stream(name: str, src: str):
    """Idempotently register the ring RTSP as a stream in OUR go2rtc, so the
    console's Live button (WebRTC via /go2rtc/) and the speaker backchannel
    have something to talk to."""
    url = f"{GO2RTC}/api/streams?name={urllib.parse.quote(name)}&src={urllib.parse.quote(src, safe='')}"
    try:
        req = urllib.request.Request(url, method="PUT")
        urllib.request.urlopen(req, timeout=5).read()
        return True
    except Exception as e:
        log("go2rtc register failed:", e)
        return False

def discover():
    """MQTT camera-id discovery → construct RTSP + register with go2rtc."""
    global RTSP, STREAM
    user = os.environ.get("LIVESTREAM_USER", "orb"); pw = os.environ.get("LIVESTREAM_PASS", "orbstream")
    while not RTSP:
        try:
            ids = discover_mqtt()
        except Exception as e:
            log("mqtt discovery error:", e); ids = []
        if ids:
            cam = ids[0]
            STREAM = STREAM or f"{cam}_live"
            RTSP = f"rtsp://{user}:{pw}@127.0.0.1:8554/{cam}_live"
            log("autodiscovered camera:", cam, "→", STREAM)
            break
        log("no ring cameras on MQTT yet (sign in via Settings → Home → Ring)…")
        time.sleep(60)
    # Keep the stream registered in our go2rtc (it forgets on restart).
    def keep_registered():
        while True:
            register_stream(STREAM, RTSP)
            time.sleep(300)
    threading.Thread(target=keep_registered, daemon=True).start()

def main():
    if not RTSP:
        discover()
    else:
        if STREAM: register_stream(STREAM, RTSP)
    from vosk import Model, KaldiRecognizer
    model_path = "/model"
    log("loading vosk model…")
    model = Model(model_path)
    # Constrained grammar: "orb" is a rare word — open-vocabulary decoding
    # hears "or"/"herb". Restricting the recognizer to the wake phrases +
    # [unk] makes spotting reliable; everything else decodes to [unk].
    grammar = json.dumps(WAKE + ["[unk]"])
    def wake_rec():
        r = KaldiRecognizer(model, RATE, grammar)
        r.SetWords(False)
        return r
    rec = wake_rec()
    log("watching", RTSP, "for wake words:", WAKE)
    while True:
        try:
            # Ring's mic runs HOT-room quiet (~-60dB room tone, speech at
            # distance ~-40dB) — without gain the wake word sits at Vosk's
            # floor. speechnorm lifts speech toward full scale (noise less so);
            # highpass kills HVAC rumble first. Map the AAC track explicitly
            # (the stream carries aac+opus and default selection may vary).
            ff = subprocess.Popen(
                ["ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", RTSP,
                 "-vn", "-map", "0:a:0", "-af", "highpass=f=80,speechnorm=e=12.5:r=0.0001:l=1",
                 "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
                stdout=subprocess.PIPE)
            awake = False; buf = bytearray(); last_voice = time.time(); started = 0.0
            while True:
                chunk = ff.stdout.read(CHUNK)
                if not chunk: raise RuntimeError("stream ended")
                if time.time() < suppress_until:
                    continue                     # orb is talking — don't wake on our own voice
                if not awake:
                    if rec.AcceptWaveform(chunk):
                        txt = json.loads(rec.Result()).get("text", "")
                    else:
                        txt = json.loads(rec.PartialResult()).get("partial", "")
                    if txt and any(w in txt for w in WAKE):
                        log("WAKE:", txt)
                        awake = True; buf = bytearray(); started = time.time(); last_voice = time.time()
                        rec = wake_rec()
                else:
                    buf.extend(chunk)
                    # crude energy VAD for end-of-utterance
                    import audioop
                    if audioop.rms(chunk, 2) > 1200: last_voice = time.time()  # post-speechnorm scale
                    if (time.time() - last_voice > UTTER_SILENCE_S and len(buf) > RATE) or time.time() - started > UTTER_MAX_S:
                        awake = False
                        threading.Thread(target=run_session, args=(bytes(buf),), daemon=True).start()
        except Exception as e:
            log("stream error:", e, "— retrying in 10s")
            time.sleep(10)

if __name__ == "__main__":
    main()
