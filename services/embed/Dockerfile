# GPU text embeddings (bge via sentence-transformers). Built on the proven
# cu130 torch base; small model (~110M), fast on the GB10.
FROM personaplex:cuda

RUN uv pip install --python /app/moshi/.venv/bin/python \
    "sentence-transformers>=3.0" "transformers>=4.40" \
    "fastapi>=0.110" "uvicorn>=0.29"

WORKDIR /srv
COPY server.py /srv/server.py

ENV RAK00N_EMBED_PORT=8994
EXPOSE 8994
CMD ["/app/moshi/.venv/bin/python", "/srv/server.py"]
