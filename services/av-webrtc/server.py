"""
rak00n WebRTC A/V ingest.

A remote laptop's browser shares its camera + mic over WebRTC; this service
(aiortc) terminates the peer connection on the Spark, samples video frames
(~2 fps) into JPEGs, and pushes the latest one to the rak00n API's in-memory
frame buffer (POST /v1/av/frame). The agent's Vision tool then "sees" it.

Signaling is a single authed POST /offer (the browser sends its rak00n
session token); the same token authorizes the frame pushes, so only the
signed-in owner's stream reaches the agent.

Env:
  RAK00N_API_URL      where to push frames (default http://rak00n-api:8080)
  RAK00N_AV_FPS       frame sample rate (default 2)
  RAK00N_AV_PORT      listen port (default 8993)
"""
import asyncio
import io
import os
import logging

import requests
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("av-webrtc")

API_URL = os.environ.get("RAK00N_API_URL", "http://rak00n-api:8080").rstrip("/")
FPS = float(os.environ.get("RAK00N_AV_FPS", "2"))
PORT = int(os.environ.get("RAK00N_AV_PORT", "8993"))
pcs: set[RTCPeerConnection] = set()


def push_frame(jpeg: bytes, token: str) -> None:
    try:
        requests.post(
            f"{API_URL}/v1/av/frame",
            headers={"Authorization": f"Bearer {token}", "content-type": "application/octet-stream"},
            data=jpeg, timeout=4,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("frame push failed: %s", e)


async def consume_video(track, token: str) -> None:
    """Sample frames at ~FPS and push the latest JPEG to the API."""
    interval = 1.0 / max(0.5, FPS)
    last = 0.0
    while True:
        try:
            frame = await track.recv()
        except Exception:
            break
        now = asyncio.get_event_loop().time()
        if now - last < interval:
            continue
        last = now
        try:
            img = frame.to_image()  # PIL Image (av VideoFrame)
            img.thumbnail((768, 768))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            await asyncio.get_event_loop().run_in_executor(None, push_frame, buf.getvalue(), token)
        except Exception as e:  # noqa: BLE001
            log.warning("frame encode failed: %s", e)


async def offer(request: web.Request) -> web.Response:
    params = await request.json()
    token = params.get("token", "")
    if not token:
        return web.json_response({"error": "token required"}, status=401)

    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("track")
    def on_track(track):
        log.info("track received: %s", track.kind)
        if track.kind == "video":
            asyncio.ensure_future(consume_video(track, token))

        @track.on("ended")
        async def on_ended():
            log.info("track ended: %s", track.kind)

    @pc.on("connectionstatechange")
    async def on_state():
        log.info("pc state: %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "engine": "aiortc", "peers": len(pcs), "fps": FPS})


async def on_shutdown(_app):
    await asyncio.gather(*[pc.close() for pc in pcs])
    pcs.clear()


def main():
    app = web.Application()
    app.router.add_post("/offer", offer)
    app.router.add_get("/health", health)
    app.on_shutdown.append(on_shutdown)
    log.info("av-webrtc on :%d → frames to %s @ %.1f fps", PORT, API_URL, FPS)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)


if __name__ == "__main__":
    main()
