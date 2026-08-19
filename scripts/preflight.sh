#!/usr/bin/env bash
#
# orb2 preflight — detect what this machine can run and say it plainly.
#
# Prints a report and exits with a verdict in $ORB2_PREFLIGHT (also echoed):
#   LOCAL_FULL    NVIDIA GPU with enough memory: local brain + local voice
#   LOCAL_VOICE   NVIDIA GPU too small for the brain: cloud brain + local voice
#   CLOUD_ONLY    no NVIDIA GPU: cloud brain required, voice off
#
# The ~27B NVFP4 brain needs ≈24GB weights and ≈60GB+ during load on
# unified-memory boxes; voice (whisper/Kokoro/embeddings) needs ≈8GB.
set -uo pipefail

say(){ printf '%s\n' "$*"; }
OS=$(uname -s); ARCH=$(uname -m)
say "── orb2 preflight ──"
say "os: $OS  arch: $ARCH"

GPU=""; VRAM_GB=0
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [ -n "${MIB:-}" ] && [ "$MIB" != "[N/A]" ] 2>/dev/null; then VRAM_GB=$(( MIB / 1024 )); fi
fi
RAM_GB=8
if [ "$OS" = "Linux" ]; then RAM_GB=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo); fi
if [ "$OS" = "Darwin" ]; then RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 )); fi

# Unified-memory boxes (DGX Spark / Jetson) report [N/A] VRAM — use system RAM.
if [ -n "$GPU" ] && [ "$VRAM_GB" -eq 0 ]; then VRAM_GB=$RAM_GB; fi

if [ -n "$GPU" ]; then say "gpu: $GPU (${VRAM_GB}GB)"; else say "gpu: none detected"; fi
say "ram: ${RAM_GB}GB"

VERDICT=CLOUD_ONLY
if [ -n "$GPU" ]; then
  if [ "$VRAM_GB" -ge 80 ]; then VERDICT=LOCAL_FULL
  elif [ "$VRAM_GB" -ge 12 ]; then VERDICT=LOCAL_VOICE
  fi
fi

say ""
case "$VERDICT" in
  LOCAL_FULL)
    say "✓ This machine can run EVERYTHING locally: brain, voice, vision.";;
  LOCAL_VOICE)
    say "◐ This GPU can run local VOICE (speech in/out) but is too small for"
    say "  the ~27B local brain. The brain MUST run in the cloud: set"
    say "  OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL in .env"
    say "  (OpenRouter / OpenAI / Anthropic's OpenAI-compatible endpoint).";;
  CLOUD_ONLY)
    say "✗ No NVIDIA GPU. The brain MUST be a cloud model (OpenRouter /"
    say "  OpenAI / Anthropic key in .env), and voice is unavailable —"
    say "  the speech services need a local NVIDIA GPU. Chat, widgets,"
    say "  smart home, and vision (via a cloud vision model) all work.";;
esac
say ""
echo "ORB2_PREFLIGHT=$VERDICT"
export ORB2_PREFLIGHT=$VERDICT
