#!/usr/bin/env bash
# Install the local voice stack: whisper.cpp (STT) + Piper (TTS).
# Default backend for ORB2 voice (ORB2_VOICE_BACKEND=whisper).
#
# Env:
#   WHISPER_DIR   install dir for whisper.cpp (default ~/.rakoon/whisper.cpp)
#   WHISPER_MODEL ggml model to fetch (default base.en)
#   PIPER_DIR     install dir for piper       (default ~/.rakoon/piper)
#   PIPER_VOICE   piper voice to fetch        (default en_US-amy-medium)
set -euo pipefail

WHISPER_DIR=${WHISPER_DIR:-$HOME/.rakoon/whisper.cpp}
WHISPER_MODEL=${WHISPER_MODEL:-base.en}
PIPER_DIR=${PIPER_DIR:-$HOME/.rakoon/piper}
PIPER_VOICE=${PIPER_VOICE:-en_US-amy-medium}

echo "── whisper.cpp ──────────────────────────────────────────"
if [ ! -d "$WHISPER_DIR" ]; then
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi
cd "$WHISPER_DIR"
cmake -B build >/dev/null
cmake --build build --config Release -j"$(nproc)"
bash ./models/download-ggml-model.sh "$WHISPER_MODEL"

WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"
WHISPER_MODEL_PATH="$WHISPER_DIR/models/ggml-${WHISPER_MODEL}.bin"
echo "✓ whisper-cli: $WHISPER_BIN"
echo "✓ model:       $WHISPER_MODEL_PATH"

echo ""
echo "── Piper (TTS) ──────────────────────────────────────────"
mkdir -p "$PIPER_DIR"
cd "$PIPER_DIR"
if [ ! -x "$PIPER_DIR/piper/piper" ]; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  PIPER_TGZ=piper_linux_x86_64.tar.gz ;;
    aarch64) PIPER_TGZ=piper_linux_aarch64.tar.gz ;;
    *) echo "Unsupported arch $ARCH for Piper prebuilt; install manually." ; PIPER_TGZ="" ;;
  esac
  if [ -n "$PIPER_TGZ" ]; then
    curl -fsSL -O "https://github.com/rhasspy/piper/releases/latest/download/${PIPER_TGZ}"
    tar xzf "$PIPER_TGZ"
  fi
fi
VOICE_ONNX="$PIPER_DIR/${PIPER_VOICE}.onnx"
if [ ! -f "$VOICE_ONNX" ]; then
  BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
  LANG_DIR=$(echo "$PIPER_VOICE" | cut -d_ -f1)
  REGION=$(echo "$PIPER_VOICE" | cut -d_ -f2 | cut -d- -f1)
  NAME=$(echo "$PIPER_VOICE" | cut -d- -f2)
  QUALITY=$(echo "$PIPER_VOICE" | cut -d- -f3)
  SUB="${LANG_DIR}/${LANG_DIR}_${REGION}/${NAME}/${QUALITY}"
  curl -fsSL -o "$VOICE_ONNX"      "${BASE}/${SUB}/${PIPER_VOICE}.onnx" || true
  curl -fsSL -o "$VOICE_ONNX.json" "${BASE}/${SUB}/${PIPER_VOICE}.onnx.json" || true
fi
PIPER_BIN="$PIPER_DIR/piper/piper"
echo "✓ piper:  $PIPER_BIN"
echo "✓ voice:  $VOICE_ONNX"

echo ""
echo "═════════════════════════════════════════════════════════"
echo "  Add to your env (EnvironmentFile / configmap / shell):"
echo "═════════════════════════════════════════════════════════"
echo "  ORB2_VOICE_ENABLED=1"
echo "  ORB2_VOICE_BACKEND=whisper"
echo "  ORB2_WHISPER_BIN=$WHISPER_BIN"
echo "  ORB2_WHISPER_MODEL=$WHISPER_MODEL_PATH"
echo "  ORB2_PIPER_BIN=$PIPER_BIN"
echo "  ORB2_PIPER_MODEL=$VOICE_ONNX"
echo "  ORB2_PIPER_SAMPLE_RATE=22050"
