# GPU STT — SenseVoiceSmall (FunASR) + faster-whisper fallback. Built on the
# PersonaPlex CUDA image which already carries a working aarch64 + Blackwell
# torch 2.12 / torchaudio 2.11 (cu130) stack, so FunASR's fbank frontend and
# CTranslate2 both have the CUDA runtime they need without a torch rebuild.
FROM personaplex:cuda

# FunASR (SenseVoice) + faster-whisper. funasr is satisfied by the venv's
# torch 2.12 / torchaudio 2.11, so it won't drag in a conflicting build.
RUN uv pip install --python /app/moshi/.venv/bin/python \
    "funasr>=1.1.0" "faster-whisper>=1.0.3" \
    "fastapi>=0.110" "uvicorn>=0.29" "python-multipart>=0.0.9" "numpy>=1.26"

WORKDIR /srv
COPY server.py /srv/server.py

ENV RAK00N_STT_PORT=8990 \
    RAK00N_STT_ENGINE=sensevoice
EXPOSE 8990
CMD ["/app/moshi/.venv/bin/python", "/srv/server.py"]
