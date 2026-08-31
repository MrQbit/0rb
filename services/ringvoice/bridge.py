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

def log(*a): print("[ringvoice]", *a, flush=True)

def speak_to_ring(pcm24k: bytes):
    """TTS PCM (24k mono s16le) → WAV → go2rtc backchannel → Ring speaker."""
    if not STREAM:
        log("no RING_STREAM set — skipping speaker output"); return
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        w = wave.open(f, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(pcm24k); w.close(); path = f.name
    # go2rtc two-way: POST the audio file as a producer into the stream's backchannel
    src = f"ffmpeg:{path}#audio=opus"
    url = f"{GO2RTC}/api/streams?dst={STREAM}&src={urllib.parse.quote(src, safe='')}"
    try:
        req = urllib.request.Request(url, method="POST")
        urllib.request.urlopen(req, timeout=15).read()
        log("spoke", len(pcm24k) // 48000, "s to the Ring speaker")
    except Exception as e:
        log("speaker push failed:", e)
    finally:
        # give go2rtc time to play before unlink
        threading.Timer(30, lambda: os.unlink(path) if os.path.exists(path) else None).start()

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

def discover():
    """Poll go2rtc for the first *_live stream once ring-mqtt is authenticated."""
    global RTSP, STREAM
    user = os.environ.get("LIVESTREAM_USER", "orb"); pw = os.environ.get("LIVESTREAM_PASS", "orbstream")
    while not RTSP:
        try:
            with urllib.request.urlopen(GO2RTC + "/api/streams", timeout=5) as r:
                names = list(json.loads(r.read()).keys())
            live = [n for n in names if n.endswith("_live")]
            if live:
                STREAM = STREAM or live[0]
                RTSP = f"rtsp://{user}:{pw}@127.0.0.1:8554/{live[0]}"
                log("autodiscovered stream:", live[0])
                return
        except Exception:
            pass
        log("waiting for ring-mqtt streams (authenticate at :55123)…")
        time.sleep(60)

def main():
    if not RTSP:
        discover()
    from vosk import Model, KaldiRecognizer
    model_path = "/model"
    log("loading vosk model…")
    model = Model(model_path)
    rec = KaldiRecognizer(model, RATE)
    rec.SetWords(False)
    log("watching", RTSP, "for wake words:", WAKE)
    while True:
        try:
            ff = subprocess.Popen(
                ["ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", RTSP,
                 "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
                stdout=subprocess.PIPE)
            awake = False; buf = bytearray(); last_voice = time.time(); started = 0.0
            while True:
                chunk = ff.stdout.read(CHUNK)
                if not chunk: raise RuntimeError("stream ended")
                if not awake:
                    if rec.AcceptWaveform(chunk):
                        txt = json.loads(rec.Result()).get("text", "")
                    else:
                        txt = json.loads(rec.PartialResult()).get("partial", "")
                    if txt and any(w in txt for w in WAKE):
                        log("WAKE:", txt)
                        awake = True; buf = bytearray(); started = time.time(); last_voice = time.time()
                        rec = KaldiRecognizer(model, RATE)
                else:
                    buf.extend(chunk)
                    # crude energy VAD for end-of-utterance
                    import audioop
                    if audioop.rms(chunk, 2) > 500: last_voice = time.time()
                    if (time.time() - last_voice > UTTER_SILENCE_S and len(buf) > RATE) or time.time() - started > UTTER_MAX_S:
                        awake = False
                        threading.Thread(target=run_session, args=(bytes(buf),), daemon=True).start()
        except Exception as e:
            log("stream error:", e, "— retrying in 10s")
            time.sleep(10)

if __name__ == "__main__":
    main()
