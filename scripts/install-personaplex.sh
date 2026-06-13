#!/usr/bin/env bash
# Install PersonaPlex (NVIDIA Moshi) for voice mode.
# Requires: Python 3.10+, ORB2_HF_TOKEN env var for gated model download.
set -euo pipefail

HF_TOKEN="${ORB2_HF_TOKEN:-${HF_TOKEN:-}}"

echo "=== orb2 PersonaPlex (Moshi) Setup ==="

# Prerequisites
apt-get install -y libopus-dev libsndfile1 2>/dev/null || echo "(apt-get failed — may need sudo or non-Debian system)"

# Clone PersonaPlex if not present
if [ ! -d /opt/personaplex ]; then
  echo "→ Cloning PersonaPlex..."
  git clone https://github.com/NVIDIA/personaplex /opt/personaplex
else
  echo "✓ PersonaPlex already cloned"
fi

# Install Python package
echo "→ Installing moshi Python package..."
pip install --quiet /opt/personaplex/moshi/.

# Authenticate HuggingFace
if [ -n "$HF_TOKEN" ]; then
  echo "→ Authenticating with HuggingFace..."
  python3 -c "from huggingface_hub import login; login('${HF_TOKEN}')"
else
  echo "⚠ ORB2_HF_TOKEN not set — model download may fail for gated models"
fi

echo ""
echo "✓ PersonaPlex installed"
echo "  Run: make voice-start"
