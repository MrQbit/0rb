"""
Benchmark the streaming Orpheus engine inside the tts container.

Reports, per sentence (after a warm-up pass that absorbs the torch.compile
cost): time-to-first-audio (TTFA) and realtime-factor (RTF = wall / audio).
RTF < 1.0 means we synthesize faster than playback — i.e. gapless streaming.
Writes the last sample to /tmp/orpheus_bench.wav.
"""
import os, time, wave
import numpy as np

os.environ.setdefault("RAK00N_TTS_ENGINE", "orpheus")
import server  # noqa: E402

SR = server.SAMPLE_RATE
SENTENCES = [
    "Hey — good to see you.",
    "Oh, that's actually a good one <laugh>. Let me pull it up for you.",
    "I looked into it, and honestly the numbers don't add up <sigh>.",
]


def run(text, tag):
    t0 = time.perf_counter()
    first = None
    pcm = bytearray()
    for chunk in server.orpheus_stream(text, "tara", 1.0):
        if first is None:
            first = time.perf_counter() - t0
        pcm += chunk
    wall = time.perf_counter() - t0
    samples = len(pcm) // 2
    dur = samples / SR
    rtf = wall / dur if dur else float("inf")
    print(f"[{tag}] TTFA={first*1000:5.0f}ms  audio={dur:4.2f}s  wall={wall:4.2f}s  RTF={rtf:4.2f}  "
          f"{'OK realtime' if rtf < 1.0 else 'SLOW'}", flush=True)
    return pcm


print("warming up (compile + cudagraphs)...", flush=True)
tw = time.perf_counter()
run("Warming up the voice engine now.", "warmup")
print(f"warm-up wall={time.perf_counter()-tw:.1f}s\n", flush=True)

last = b""
for i, s in enumerate(SENTENCES):
    last = run(s, f"sent{i+1}")

with wave.open("/tmp/orpheus_bench.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(bytes(last))
print("\nwrote /tmp/orpheus_bench.wav", flush=True)
