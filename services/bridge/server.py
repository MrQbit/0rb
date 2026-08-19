"""LAN bridge: direct access to network devices, no Home Assistant required.

Three jobs, all needing the host network:
  1. Discover AirPlay speakers/TVs (pyatv scan) and IPP printers (zeroconf)
     and keep a live registry.
  2. Act on them directly: stream audio to AirPlay (RAOP via pyatv) and
     print to IPP printers (minimal IPP client, no CUPS).
  3. Advertise the orb console itself as _orb2._tcp so native apps can
     auto-discover the server on the LAN.

HTTP API (for orb2-api, reached via the host gateway):
  GET  /health                      liveness
  GET  /devices                     {speakers:[...], printers:[...]}
  POST /play      {id, url}         stream an audio file/URL to a speaker
  POST /stop      {id}              stop playback
  POST /volume    {id, level}       0-100
  GET  /status?id=                  {playing, volume}
  POST /announce?id=&volume=        body = WAV/MP3 bytes -> play on speaker
  GET  /printer?id=                 IPP Get-Printer-Attributes summary
  POST /print?id=&format=&name=     body = document bytes -> IPP Print-Job
"""
import asyncio
import logging
import os
import socket
import struct
import tempfile
import time

import pyatv
from aiohttp import web
from zeroconf import IPVersion, ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf, ServiceInfo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

PORT = int(os.environ.get("ORB2_BRIDGE_PORT", "8997"))
TOKEN = os.environ.get("ORB2_BRIDGE_TOKEN", "")

# ── device registries ────────────────────────────────────────────────────
speakers: dict[str, dict] = {}      # id -> {name, address, model, protocols}
speaker_confs: dict[str, object] = {}  # id -> pyatv conf (for connect)
printers: dict[str, dict] = {}      # id -> {name, address, port, rp, pdl, ...}
players: dict[str, dict] = {}       # id -> {atv, task, started}
locks: dict[str, asyncio.Lock] = {}


def lan_ip() -> str:
    override = os.environ.get("ORB2_DEVICE_LAN_IP", "").strip()
    if override:
        return override
    s = socket.socket(socket.SOCK_DGRAM.__class__ and socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


# ── AirPlay discovery + playback (pyatv) ─────────────────────────────────
async def scan_airplay(loop):
    try:
        confs = await pyatv.scan(loop, timeout=6)
    except Exception as e:
        log.warning("airplay scan failed: %s", e)
        return
    found = {}
    for c in confs:
        protos = [s.protocol.name.lower() for s in c.services]
        # Only targets we can actually stream audio to.
        if not any(p in ("raop", "airplay") for p in protos):
            continue
        dev_id = str(c.identifier or f"{c.address}")
        found[dev_id] = {
            "id": dev_id,
            "name": c.name,
            "address": str(c.address),
            "model": str(getattr(c.device_info, "model_str", "") or getattr(c.device_info, "raw_model", "") or ""),
            "protocols": protos,
        }
        speaker_confs[dev_id] = c
    speakers.clear()
    speakers.update(found)
    log.info("airplay scan: %d streamable device(s): %s", len(found), ", ".join(d["name"] for d in found.values()))


def _lock(dev_id: str) -> asyncio.Lock:
    return locks.setdefault(dev_id, asyncio.Lock())


async def _connect(dev_id: str):
    conf = speaker_confs.get(dev_id)
    if conf is None:
        raise web.HTTPNotFound(text="unknown device — rescan pending?")
    return await pyatv.connect(conf, asyncio.get_event_loop())


async def stop_playback(dev_id: str):
    p = players.pop(dev_id, None)
    if not p:
        return False
    p["task"].cancel()
    try:
        await p["task"]
    except (asyncio.CancelledError, Exception):
        pass
    try:
        p["atv"].close()
    except Exception:
        pass
    return True


async def start_playback(dev_id: str, source: str, volume: float | None, cleanup: str | None = None):
    """Stream `source` (file path or URL) to the device as a background task."""
    async with _lock(dev_id):
        await stop_playback(dev_id)
        atv = await _connect(dev_id)
        if volume is not None:
            try:
                await atv.audio.set_volume(max(0.0, min(100.0, volume)))
            except Exception as e:
                log.warning("set_volume failed on %s: %s", dev_id, e)

        async def run():
            try:
                await atv.stream.stream_file(source)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("stream to %s ended with error: %s", dev_id, e)
            finally:
                players.pop(dev_id, None)
                try:
                    atv.close()
                except Exception:
                    pass
                if cleanup:
                    try:
                        os.unlink(cleanup)
                    except OSError:
                        pass

        players[dev_id] = {"atv": atv, "task": asyncio.create_task(run()), "started": time.time()}


# ── IPP printers: zeroconf discovery + minimal IPP client ────────────────
def _printer_from_info(info: AsyncServiceInfo) -> dict | None:
    addrs = info.parsed_scoped_addresses(IPVersion.V4Only)
    if not addrs:
        return None
    props = {k.decode(): (v.decode() if isinstance(v, bytes) else str(v)) for k, v in (info.properties or {}).items() if v is not None}
    name = info.name.split("._ipp.")[0]
    return {
        "id": props.get("UUID", name),
        "name": props.get("ty", name),
        "address": addrs[0],
        "port": info.port or 631,
        "rp": props.get("rp", "ipp/print"),
        "pdl": [p for p in props.get("pdl", "").split(",") if p],
        "location": props.get("note", ""),
    }


def on_ipp_change(zeroconf, service_type, name, state_change):
    async def handle():
        if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
            info = AsyncServiceInfo(service_type, name)
            if await info.async_request(zeroconf, 3000):
                p = _printer_from_info(info)
                if p:
                    printers[p["id"]] = p
                    log.info("printer: %s @ %s:%s (pdl: %s)", p["name"], p["address"], p["port"], ",".join(p["pdl"])[:120])
        elif state_change is ServiceStateChange.Removed:
            for pid, p in list(printers.items()):
                if name.startswith(p["name"]) or name.split("._ipp.")[0] == p["name"]:
                    printers.pop(pid, None)
    asyncio.ensure_future(handle())


# Minimal IPP/1.1 encoder + tolerant decoder — enough for Get-Printer-
# Attributes and Print-Job against AirPrint-class printers.
def ipp_encode(op: int, uri: str, extra: list[tuple[int, str, bytes]], doc: bytes = b"") -> bytes:
    out = bytearray()
    out += struct.pack(">BBhi", 1, 1, op, 1)          # IPP/1.1, operation, request-id
    out += b"\x01"                                     # operation-attributes-tag
    def attr(tag: int, name: str, value: bytes):
        out.extend(struct.pack(">B", tag))
        out.extend(struct.pack(">h", len(name)) + name.encode())
        out.extend(struct.pack(">h", len(value)) + value)
    attr(0x47, "attributes-charset", b"utf-8")
    attr(0x48, "attributes-natural-language", b"en")
    attr(0x45, "printer-uri", uri.encode())
    attr(0x42, "requesting-user-name", b"orb")
    for tag, name, value in extra:
        attr(tag, name, value)
    out += b"\x03"                                     # end-of-attributes
    out += doc
    return bytes(out)


def ipp_decode(data: bytes) -> dict:
    if len(data) < 9:
        raise ValueError("short IPP response")
    status = struct.unpack(">h", data[2:4])[0]
    attrs: dict[str, list] = {}
    i, name = 8, ""
    while i < len(data):
        tag = data[i]; i += 1
        if tag == 0x03:
            break
        if tag <= 0x0F:                                # delimiter/group tag
            continue
        nlen = struct.unpack(">h", data[i:i + 2])[0]; i += 2
        if nlen:
            name = data[i:i + nlen].decode("utf-8", "replace"); i += nlen
        vlen = struct.unpack(">h", data[i:i + 2])[0]; i += 2
        raw = data[i:i + vlen]; i += vlen
        if tag in (0x21, 0x23):                        # integer / enum
            val = struct.unpack(">i", raw)[0] if vlen == 4 else 0
        else:
            val = raw.decode("utf-8", "replace")
        attrs.setdefault(name, []).append(val)
    return {"status": status, "attrs": attrs}


async def ipp_call(p: dict, op: int, extra: list, doc: bytes = b"") -> dict:
    import aiohttp
    uri = f"ipp://{p['address']}:{p['port']}/{p['rp']}"
    url = f"http://{p['address']}:{p['port']}/{p['rp']}"
    body = ipp_encode(op, uri, extra, doc)
    async with aiohttp.ClientSession() as s:
        async with s.post(url, data=body, headers={"Content-Type": "application/ipp"}, timeout=aiohttp.ClientTimeout(total=30)) as r:
            if r.status != 200:
                raise web.HTTPBadGateway(text=f"printer HTTP {r.status}")
            return ipp_decode(await r.read())


PRINTER_STATES = {3: "idle", 4: "printing", 5: "stopped"}


# ── HTTP API ─────────────────────────────────────────────────────────────
def check_token(req: web.Request):
    if TOKEN and req.headers.get("X-Bridge-Token") != TOKEN:
        raise web.HTTPUnauthorized(text="bad bridge token")


async def h_health(_):
    return web.json_response({"ok": True, "speakers": len(speakers), "printers": len(printers)})


async def h_devices(req):
    check_token(req)
    return web.json_response({"speakers": sorted(speakers.values(), key=lambda d: d["name"]),
                              "printers": sorted(printers.values(), key=lambda d: d["name"])})


async def h_play(req):
    check_token(req)
    b = await req.json()
    dev_id, url = str(b.get("id", "")), str(b.get("url", ""))
    if dev_id not in speaker_confs or not url:
        raise web.HTTPBadRequest(text="need id (known speaker) and url")
    vol = b.get("volume")
    await start_playback(dev_id, url, float(vol) if vol is not None else None)
    return web.json_response({"ok": True, "playing": url})


async def h_stop(req):
    check_token(req)
    b = await req.json()
    stopped = await stop_playback(str(b.get("id", "")))
    return web.json_response({"ok": True, "stopped": stopped})


async def h_volume(req):
    check_token(req)
    b = await req.json()
    dev_id = str(b.get("id", ""))
    level = max(0.0, min(100.0, float(b.get("level", 50))))
    async with _lock(dev_id):
        p = players.get(dev_id)
        if p:  # adjust the live session
            await p["atv"].audio.set_volume(level)
        else:
            atv = await _connect(dev_id)
            try:
                await atv.audio.set_volume(level)
            finally:
                atv.close()
    return web.json_response({"ok": True, "level": level})


async def h_status(req):
    check_token(req)
    dev_id = req.query.get("id", "")
    p = players.get(dev_id)
    out = {"playing": bool(p)}
    if p:
        out["since"] = int(time.time() - p["started"])
        try:
            out["volume"] = p["atv"].audio.volume
        except Exception:
            pass
    return web.json_response(out)


async def h_announce(req):
    check_token(req)
    dev_id = req.query.get("id", "")
    if dev_id not in speaker_confs:
        raise web.HTTPBadRequest(text="unknown speaker")
    audio = await req.read()
    if len(audio) < 64:
        raise web.HTTPBadRequest(text="no audio")
    suffix = ".mp3" if req.content_type == "audio/mpeg" else ".wav"
    f = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    f.write(audio); f.close()
    vol = req.query.get("volume")
    await start_playback(dev_id, f.name, float(vol) if vol else None, cleanup=f.name)
    return web.json_response({"ok": True})


async def h_printer(req):
    check_token(req)
    p = printers.get(req.query.get("id", ""))
    if not p:
        raise web.HTTPNotFound(text="unknown printer")
    res = await ipp_call(p, 0x000B, [])  # Get-Printer-Attributes
    a = res["attrs"]
    state = a.get("printer-state", [0])[0]
    return web.json_response({
        "ok": res["status"] < 0x100,
        "state": PRINTER_STATES.get(state, str(state)),
        "reasons": a.get("printer-state-reasons", []),
        "make": a.get("printer-make-and-model", [""])[0],
        "formats": a.get("document-format-supported", p.get("pdl", [])),
    })


async def h_print(req):
    check_token(req)
    p = printers.get(req.query.get("id", ""))
    if not p:
        raise web.HTTPNotFound(text="unknown printer")
    fmt = req.query.get("format", "application/pdf")
    name = req.query.get("name", "orb document")
    doc = await req.read()
    if not doc:
        raise web.HTTPBadRequest(text="empty document")
    res = await ipp_call(p, 0x0002, [                  # Print-Job
        (0x42, "job-name", name.encode()),
        (0x49, "document-format", fmt.encode()),
    ], doc)
    ok = res["status"] < 0x100
    return web.json_response({
        "ok": ok,
        "ipp_status": res["status"],
        "job_id": res["attrs"].get("job-id", [None])[0],
        "job_state": res["attrs"].get("job-state", [None])[0],
    }, status=200 if ok else 502)


# ── main ─────────────────────────────────────────────────────────────────
async def main():
    loop = asyncio.get_event_loop()
    azc = AsyncZeroconf(ip_version=IPVersion.V4Only)

    # Advertise the console for app auto-discovery. TXT carries every URL a
    # client might need; the app picks the best one it can reach.
    ip = lan_ip()
    props = {
        "path": "/",
        "http": os.environ.get("ORB2_UI_PORT", "9080"),
        "https": os.environ.get("ORB2_UI_HTTPS_PORT", "9443"),
    }
    if os.environ.get("ORB2_PUBLIC_URL"):
        props["public"] = os.environ["ORB2_PUBLIC_URL"]
    if os.environ.get("ORB2_DEVICE_URL"):
        props["device"] = os.environ["ORB2_DEVICE_URL"]
    name = os.environ.get("ORB2_ADVERTISE_NAME", "Orb") or "Orb"
    svc = ServiceInfo(
        "_orb2._tcp.local.",
        f"{name}._orb2._tcp.local.",
        addresses=[socket.inet_aton(ip)],
        port=int(props["http"]),
        properties=props,
        server=f"{socket.gethostname()}.local.",
    )
    await azc.async_register_service(svc)
    log.info("advertising _orb2._tcp as '%s' at %s:%s", name, ip, props["http"])

    AsyncServiceBrowser(azc.zeroconf, ["_ipp._tcp.local."], handlers=[on_ipp_change])

    async def rescan():
        while True:
            await scan_airplay(loop)
            await asyncio.sleep(120)
    asyncio.create_task(rescan())

    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get("/health", h_health)
    app.router.add_get("/devices", h_devices)
    app.router.add_post("/play", h_play)
    app.router.add_post("/stop", h_stop)
    app.router.add_post("/volume", h_volume)
    app.router.add_get("/status", h_status)
    app.router.add_post("/announce", h_announce)
    app.router.add_get("/printer", h_printer)
    app.router.add_post("/print", h_print)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("bridge listening on :%d", PORT)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
