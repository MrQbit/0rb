"""
Offline smoke test for the Orpheus engine — run inside the tts container once
the weights are cached. Synthesizes a short line (with a <laugh> cue) and
reports duration + RMS so we can confirm it produces real, non-silent speech
before flipping the live engine. Writes /tmp/orpheus_test.wav for a listen.
"""
import os, wave, numpy as np

os.environ.setdefault("ORB2_TTS_ENGINE", "orpheus")
import server  # noqa: E402  (uses the same engine code the service serves)

TEXT = "Oh, that's actually a good one <laugh>. Let me pull it up for you."
pcm = b"".join(server.orpheus_stream(TEXT, "tara", 1.0))
if not pcm:
    raise SystemExit("FAIL: orpheus produced no audio")

a = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
dur = len(a) / server.SAMPLE_RATE
rms = float(np.sqrt(np.mean(a * a)))
with wave.open("/tmp/orpheus_test.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(server.SAMPLE_RATE)
    w.writeframes(pcm)
print(f"OK orpheus: {dur:.2f}s @ {server.SAMPLE_RATE}Hz, rms={rms:.4f} -> /tmp/orpheus_test.wav")
if dur < 0.5 or rms < 0.005:
    raise SystemExit("WARN: suspiciously short/quiet — check decode math")
