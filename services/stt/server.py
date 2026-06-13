"""
orb2 GPU STT service — SenseVoice (primary) with faster-whisper fallback.

Why SenseVoice: it transcribes AND, in the same forward pass, recognises the
speaker's emotion (happy/sad/angry/…) and audio events (laughter, sigh,
cough, applause). The cascade brain is text-only, so we extract those
paralinguistic tags here and the voice backend pipes them into the prompt —
the agent then "hears how you said it", recovering most of what a full
speech-to-speech Omni model would give, without leaving the stable cascade.

Engine is selectable so the proven path always survives:
  ORB2_STT_ENGINE=sensevoice   (default) FunASR SenseVoiceSmall
  ORB2_STT_ENGINE=whisper      faster-whisper (CTranslate2), the old engine

Reached by the API over the compose network at http://stt:8990.

Contract (consumed by src/api/voice/whisperBackend.ts):

  GET  /health        -> {"ok": true, "engine": "sensevoice"|"faster-whisper",
                          "model": "...", "device": "cuda"}
  POST /transcribe    -> {"text": "...",            # clean transcript (no tags)
                          "emotion": "frustrated",  # '' when neutral/unknown
                          "events": ["sigh"],       # [] when none
                          "lang": "en"}
       Accepts either:
         * multipart/form-data with a `file` field (WAV), or
         * application/octet-stream raw PCM16LE mono 16 kHz body
"""
from __future__ import annotations

import io
import os
import wave
import logging
import tempfile

import numpy as np
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stt")

SAMPLE_RATE = 16000
ENGINE = os.environ.get("ORB2_STT_ENGINE", "sensevoice").lower()
LANG = os.environ.get("ORB2_STT_LANG", "auto")  # SenseVoice: auto/en/zh/ja/ko/yue

# faster-whisper knobs (fallback engine)
WHISPER_MODEL = os.environ.get("ORB2_STT_MODEL", "small.en")
WHISPER_COMPUTE = os.environ.get("ORB2_STT_COMPUTE", "float16")

# SenseVoice knobs. Default to the HuggingFace hub (fast CDN + our HF_TOKEN);
# set ORB2_SENSEVOICE_HUB=ms to use ModelScope instead.
SENSEVOICE_HUB = os.environ.get("ORB2_SENSEVOICE_HUB", "hf").lower()
SENSEVOICE_MODEL = os.environ.get(
    "ORB2_SENSEVOICE_MODEL",
    "FunAudioLLM/SenseVoiceSmall" if SENSEVOICE_HUB == "hf" else "iic/SenseVoiceSmall",
)

app = FastAPI(title="orb2-stt", version="2.0")
_model = None
_device = "cpu"
_engine = ENGINE  # may flip to "faster-whisper" if SenseVoice fails to load

# SenseVoice special tokens → friendly words the LLM understands.
# Emotion tokens it can emit: NEUTRAL/HAPPY/SAD/ANGRY/FEARFUL/DISGUSTED/SURPRISED.
_EMOTION_MAP = {
    "HAPPY": "happy",
    "SAD": "sad",
    "ANGRY": "angry",
    "FEARFUL": "anxious",
    "DISGUSTED": "disgusted",
    "SURPRISED": "surprised",
    # NEUTRAL / EMO_UNKNOWN deliberately omitted → reported as no emotion.
}
# Audio-event tokens it can emit alongside speech.
_EVENT_MAP = {
    "Laughter": "laughter",
    "Crying": "crying",
    "Sneeze": "sneeze",
    "Cough": "cough",
    "Breath": "sigh",        # SenseVoice tags audible breaths; read as a sigh
    "Applause": "applause",
    "BGM": "background music",
}


def _load_sensevoice():
    """Build the FunASR SenseVoiceSmall model on GPU (fallback CPU)."""
    from funasr import AutoModel
    import torch

    attempts = ["cuda:0", "cpu"] if torch.cuda.is_available() else ["cpu"]
    last_err = None
    for dev in attempts:
        try:
            log.info("loading SenseVoice '%s' on %s", SENSEVOICE_MODEL, dev)
            m = AutoModel(
                model=SENSEVOICE_MODEL,
                hub=SENSEVOICE_HUB,
                trust_remote_code=False,
                device=dev,
                disable_update=True,
            )
            log.info("SenseVoice ready on %s", dev)
            return m, ("cuda" if dev.startswith("cuda") else "cpu")
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.warning("SenseVoice load on %s failed: %s", dev, e)
    raise RuntimeError(f"SenseVoice failed on all devices: {last_err}")


def _load_whisper():
    """Build faster-whisper (CTranslate2) on GPU (fallback CPU int8)."""
    from faster_whisper import WhisperModel
    import torch

    attempts = []
    if torch.cuda.is_available():
        attempts.append(("cuda", WHISPER_COMPUTE))
    attempts.append(("cpu", "int8"))
    last_err = None
    for dev, compute in attempts:
        try:
            log.info("loading faster-whisper '%s' on %s (%s)", WHISPER_MODEL, dev, compute)
            m = WhisperModel(WHISPER_MODEL, device=dev, compute_type=compute)
            log.info("faster-whisper ready on %s", dev)
            return m, dev
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.warning("faster-whisper load on %s failed: %s", dev, e)
    raise RuntimeError(f"faster-whisper failed on all devices: {last_err}")


def model():
    """Lazily load the selected engine; fall back to whisper if SenseVoice dies."""
    global _model, _device, _engine
    if _model is not None:
        return _model
    if _engine == "sensevoice":
        try:
            _model, _device = _load_sensevoice()
            return _model
        except Exception as e:  # noqa: BLE001 — keep voice alive on the old engine
            log.error("SenseVoice unavailable, falling back to faster-whisper: %s", e)
            _engine = "faster-whisper"
    _model, _device = _load_whisper()
    return _model


def _pcm16_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def _wav_to_float(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        frames = w.readframes(w.getnframes())
    return _pcm16_to_float(frames)


def _parse_sensevoice(raw: str):
    """
    Split SenseVoice's tagged output into (clean_text, emotion, events, lang).

    Raw looks like: "<|en|><|HAPPY|><|Speech|><|withitn|>hello there".
    We pull every <|TOKEN|>, classify it, and strip them all from the text.
    """
    import re

    emotion = ""
    events: list[str] = []
    lang = ""
    for tok in re.findall(r"<\|([^|]+)\|>", raw):
        if tok in _EMOTION_MAP and not emotion:
            emotion = _EMOTION_MAP[tok]
        elif tok in _EVENT_MAP:
            label = _EVENT_MAP[tok]
            if label not in events:
                events.append(label)
        elif tok.lower() in ("en", "zh", "ja", "ko", "yue", "nospeech"):
            lang = tok.lower()
        # Speech / withitn / woitn / EMO_UNKNOWN / NEUTRAL → ignore.
    clean = re.sub(r"<\|[^|]+\|>", "", raw).strip()
    return clean, emotion, events, lang


def _transcribe(samples: np.ndarray):
    """Return (text, emotion, events, lang) for the captured utterance."""
    if samples.size == 0:
        return "", "", [], ""
    m = model()
    if _engine == "sensevoice":
        # FunASR wants a path or tensor; a temp WAV is the most robust input.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tf:
            with wave.open(tf.name, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            res = m.generate(
                input=tf.name,
                cache={},
                language=LANG,
                use_itn=True,
                ban_emo_unk=False,
                batch_size_s=60,
            )
        raw = (res[0].get("text") if res else "") or ""
        return _parse_sensevoice(raw)
    # faster-whisper: transcript only, no paralinguistics.
    segments, info = m.transcribe(
        samples,
        language=None if LANG == "auto" else LANG,
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    text = "".join(s.text for s in segments).strip()
    return text, "", [], (getattr(info, "language", "") or "")


@app.get("/health")
def health():
    eng = "sensevoice" if _engine == "sensevoice" else "faster-whisper"
    model_name = SENSEVOICE_MODEL if _engine == "sensevoice" else WHISPER_MODEL
    return JSONResponse({"ok": True, "engine": eng, "model": model_name, "device": _device})


@app.post("/transcribe")
async def transcribe(request: Request, file: UploadFile | None = File(default=None)):
    if file is not None:
        samples = _wav_to_float(await file.read())
    else:
        body = await request.body()
        samples = _wav_to_float(body) if body[:4] == b"RIFF" else _pcm16_to_float(body)
    try:
        text, emotion, events, lang = _transcribe(samples)
    except Exception as e:
        log.exception("transcribe failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"text": text, "emotion": emotion, "events": events, "lang": lang})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ORB2_STT_PORT", "8990"))
    if os.environ.get("ORB2_STT_WARM", "1") == "1":
        try:
            _transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))  # 0.5s silence
        except Exception as e:
            log.warning("warm-up skipped: %s", e)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
