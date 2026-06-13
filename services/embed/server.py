"""
rak00n embedding service — local text embeddings on the GPU.

Powers semantic memory recall: turns memories and queries into vectors so
the agent can retrieve by MEANING (paraphrase-aware), not just by an LLM
scanning a flat index. Mirrors services/tts|stt|vision; the API reaches it
at http://embed:8994.

  GET  /health      -> {"ok": true, "model": "...", "dim": 768, "device": "cuda"}
  POST /embed       -> {"vectors": [[...], ...], "dim": 768}
       body: {"texts": ["...", ...], "kind": "query"|"document"}

bge-style models want an instruction prefix on queries; `kind` controls it.
"""
from __future__ import annotations

import os
import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embed")

MODEL_ID = os.environ.get("RAK00N_EMBED_MODEL", "BAAI/bge-base-en-v1.5")
QUERY_PREFIX = os.environ.get("RAK00N_EMBED_QUERY_PREFIX",
                              "Represent this sentence for searching relevant passages: ")

app = FastAPI(title="rak00n-embed", version="1.0")
_model = None
_device = "cpu"
_dim = 0


def model():
    global _model, _device, _dim
    if _model is None:
        import torch
        from sentence_transformers import SentenceTransformer
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info("loading %s on %s", MODEL_ID, _device)
        _model = SentenceTransformer(MODEL_ID, device=_device)
        _dim = _model.get_sentence_embedding_dimension()
        log.info("embeddings ready (dim=%d) on %s", _dim, _device)
    return _model


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "document"  # "query" applies the bge search instruction


@app.get("/health")
def health():
    return JSONResponse({"ok": True, "model": MODEL_ID, "dim": _dim, "device": _device})


@app.post("/embed")
def embed(req: EmbedRequest):
    if not req.texts:
        return JSONResponse({"vectors": [], "dim": _dim})
    texts = req.texts
    if req.kind == "query":
        texts = [QUERY_PREFIX + t for t in texts]
    vecs = model().encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    return JSONResponse({"vectors": vecs.tolist(), "dim": int(vecs.shape[1])})


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("RAK00N_EMBED_PORT", "8994"))
    if os.environ.get("RAK00N_EMBED_WARM", "1") == "1":
        try:
            model().encode(["warm up"], normalize_embeddings=True)
        except Exception as e:
            log.warning("warm-up skipped: %s", e)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
