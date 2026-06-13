# GPU neural TTS (Kokoro-82M). Built on the proven PersonaPlex CUDA image
# so we inherit the working aarch64 + Blackwell torch 2.12 / cu130 stack
# and don't have to rebuild torch for the GB10.
FROM personaplex:cuda

# espeak-ng is Kokoro/misaki's g2p fallback for out-of-dictionary words.
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Install into the existing uv-managed venv that already holds torch+cu130.
# transformers + snac power the optional Orpheus expressive engine; they sit
# unused (no weights loaded) unless RAK00N_TTS_ENGINE=orpheus.
RUN uv pip install --python /app/moshi/.venv/bin/python \
    "kokoro>=0.9.2" "soundfile>=0.12.1" "fastapi>=0.110" "uvicorn>=0.29" "numpy>=1.26" \
    "transformers>=4.45" "snac>=1.2.0"

# Pre-install the spaCy English model that Kokoro's misaki g2p needs.
# Without this, misaki tries to `uv pip install` it at runtime and crashes
# (uv can't find the venv). Pin to the spaCy 3.8.x-compatible model wheel.
RUN uv pip install --python /app/moshi/.venv/bin/python \
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

WORKDIR /srv
COPY server.py /srv/server.py

ENV RAK00N_TTS_PORT=8991
EXPOSE 8991
CMD ["/app/moshi/.venv/bin/python", "/srv/server.py"]
