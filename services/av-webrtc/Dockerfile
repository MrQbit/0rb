# WebRTC A/V ingest (aiortc). CPU-only, lightweight — no GPU needed.
FROM python:3.12-slim

# aiortc/PyAV need ffmpeg + a few media libs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "aiortc>=1.9" "aiohttp>=3.9" "pillow>=10" "requests>=2.31"

WORKDIR /srv
COPY server.py /srv/server.py

ENV RAK00N_AV_PORT=8993
EXPOSE 8993
CMD ["python", "/srv/server.py"]
