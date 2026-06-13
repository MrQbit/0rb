"""
rak00n vision service — moondream2.

A small vision-language model (~1.8B) that captions images and answers
questions about them ("what's in this frame?", "is the person holding
anything?", "read the text on screen"). Runs on the GPU alongside the rest,
mirroring services/tts and services/stt; the API reaches it at
http://vision:8992 on the compose network.

Contract (consumed by the Vision tool / A/V ingest):
  GET  /health                 -> {"ok": true, "engine": "moondream2", "device": "cuda"}
  POST /caption                -> {"caption": "..."}
       body: multipart `file` (image) OR application/octet-stream image bytes
  POST /query                  -> {"answer": "..."}
       multipart: `file` (image) + `question` field, OR
       JSON: {"image_b64": "...", "question": "..."}
"""
from __future__ import annotations

import io
import os
import base64
import logging

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("vision")

MODEL_ID = os.environ.get("RAK00N_VISION_MODEL", "vikhyatk/moondream2")
MODEL_REV = os.environ.get("RAK00N_VISION_REVISION", "2025-01-09")

app = FastAPI(title="rak00n-vision", version="1.0")
_model = None
_tok = None
_device = "cpu"


def model():
    global _model, _tok, _device
    if _model is None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info("loading %s (%s) on %s", MODEL_ID, MODEL_REV, _device)
        _model = AutoModelForCausalLM.from_pretrained(
            MODEL_ID, revision=MODEL_REV, trust_remote_code=True,
            torch_dtype=torch.float16 if _device == "cuda" else torch.float32,
        ).to(_device)
        _tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REV)
        log.info("moondream2 ready on %s", _device)
    return _model, _tok


def _load_image(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def _caption(img: Image.Image) -> str:
    m, tok = model()
    # moondream2 exposes caption() on recent revisions; fall back to a query.
    try:
        return m.caption(img, length="normal")["caption"].strip()
    except Exception:
        enc = m.encode_image(img)
        return m.answer_question(enc, "Describe this image in detail.", tok).strip()


def _query(img: Image.Image, question: str) -> str:
    m, tok = model()
    try:
        return m.query(img, question)["answer"].strip()
    except Exception:
        enc = m.encode_image(img)
        return m.answer_question(enc, question, tok).strip()


@app.get("/health")
def health():
    return JSONResponse({"ok": True, "engine": "moondream2", "model": MODEL_ID, "device": _device})


@app.post("/caption")
async def caption(request: Request, file: UploadFile | None = File(default=None)):
    data = await file.read() if file is not None else await request.body()
    if not data:
        return JSONResponse({"error": "no image"}, status_code=400)
    try:
        return JSONResponse({"caption": _caption(_load_image(data))})
    except Exception as e:
        log.exception("caption failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/query")
async def query(
    request: Request,
    file: UploadFile | None = File(default=None),
    question: str | None = Form(default=None),
):
    if file is not None:
        data = await file.read()
        q = question or "Describe this image."
    else:
        body = await request.json()
        data = base64.b64decode(body.get("image_b64", ""))
        q = body.get("question") or "Describe this image."
    if not data:
        return JSONResponse({"error": "no image"}, status_code=400)
    try:
        return JSONResponse({"answer": _query(_load_image(data), q)})
    except Exception as e:
        log.exception("query failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("RAK00N_VISION_PORT", "8992"))
    if os.environ.get("RAK00N_VISION_WARM", "1") == "1":
        try:
            model()  # load weights before serving
        except Exception as e:
            log.warning("warm-up skipped: %s", e)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
