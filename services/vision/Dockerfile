# GPU vision (moondream2). Built on the PersonaPlex CUDA image to inherit
# the working aarch64 + Blackwell torch 2.12 / cu130 stack.
FROM personaplex:cuda

# libvips — moondream2's modeling code uses pyvips for image crops.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libvips42 \
    && rm -rf /var/lib/apt/lists/*

# Pin transformers to a version compatible with moondream2's 2025-01-09
# remote code (newer transformers' loader expects attrs the custom model
# doesn't define, e.g. all_tied_weights_keys).
RUN uv pip install --python /app/moshi/.venv/bin/python \
    "transformers==4.46.3" "accelerate>=0.33" "einops" "pillow>=10" "pyvips" \
    "fastapi>=0.110" "uvicorn>=0.29" "python-multipart>=0.0.9"

WORKDIR /srv
COPY server.py /srv/server.py

ENV RAK00N_VISION_PORT=8992
EXPOSE 8992
CMD ["/app/moshi/.venv/bin/python", "/srv/server.py"]
