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


# ── Sonos native playback (UPnP AVTransport) ─────────────────────────────
# Era-series Sonos accept pyatv's RAOP session but render SILENCE (the
# session holds, volume acks, no audio). Their own UPnP rail — the one the
# Sonos app and Home Assistant TTS use — is fully reliable: we host the
# WAV over HTTP and tell the speaker to fetch and play it.
_sonos_cache: dict[str, bool] = {}      # address -> is-sonos
media_files: dict[str, str] = {}        # token -> temp file path

async def _is_sonos(address: str) -> bool:
    if address in _sonos_cache:
        return _sonos_cache[address]
    import aiohttp
    ok = False
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"http://{address}:1400/xml/device_description.xml",
                             timeout=aiohttp.ClientTimeout(total=3)) as r:
                ok = r.status == 200 and "sonos" in (await r.text()).lower()
    except Exception:
        ok = False
    _sonos_cache[address] = ok
    return ok

async def _sonos_soap(address: str, service: str, action: str, args: dict) -> str:
    import aiohttp
    path = {"AVTransport": "/MediaRenderer/AVTransport/Control",
            "RenderingControl": "/MediaRenderer/RenderingControl/Control"}[service]
    body_args = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    envelope = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        f'<u:{action} xmlns:u="urn:schemas-upnp-org:service:{service}:1">{body_args}</u:{action}>'
        '</s:Body></s:Envelope>')
    headers = {"Content-Type": 'text/xml; charset="utf-8"',
               "SOAPACTION": f'"urn:schemas-upnp-org:service:{service}:1#{action}"'}
    async with aiohttp.ClientSession() as s:
        async with s.post(f"http://{address}:1400{path}", data=envelope.encode(), headers=headers,
                          timeout=aiohttp.ClientTimeout(total=8)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"sonos {action} {r.status}: {text[:150]}")
            return text

async def sonos_play(dev_id: str, address: str, source: str, volume: float | None, cleanup: str | None):
    """Host `source` at /media/<token> and drive the speaker to play it."""
    import re as _re
    import secrets
    token = secrets.token_urlsafe(12) + os.path.splitext(source)[1]
    media_files[token] = source
    url = f"http://{lan_ip()}:{PORT}/media/{token}"
    prev_volume = None
    if volume is not None:
        try:
            got = await _sonos_soap(address, "RenderingControl", "GetVolume",
                                    {"InstanceID": 0, "Channel": "Master"})
            m = _re.search(r"<CurrentVolume>(\d+)</CurrentVolume>", got)
            prev_volume = int(m.group(1)) if m else None
            await _sonos_soap(address, "RenderingControl", "SetVolume",
                              {"InstanceID": 0, "Channel": "Master", "DesiredVolume": int(max(0, min(100, volume)))})
        except Exception as e:
            log.warning("sonos volume failed on %s: %s", address, e)
    await _sonos_soap(address, "AVTransport", "SetAVTransportURI",
                      {"InstanceID": 0, "CurrentURI": url, "CurrentURIMetaData": ""})
    await _sonos_soap(address, "AVTransport", "Play", {"InstanceID": 0, "Speed": 1})
    log.info("sonos playing %s on %s", token, address)

    async def watch():
        try:
            for _ in range(60):           # cap 2 min
                await asyncio.sleep(2)
                info = await _sonos_soap(address, "AVTransport", "GetTransportInfo", {"InstanceID": 0})
                if "PLAYING" not in info and "TRANSITIONING" not in info:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("sonos watch on %s: %s", address, e)
        finally:
            players.pop(dev_id, None)
            media_files.pop(token, None)
            if prev_volume is not None:      # leave the speaker as we found it
                try:
                    await _sonos_soap(address, "RenderingControl", "SetVolume",
                                      {"InstanceID": 0, "Channel": "Master", "DesiredVolume": prev_volume})
                except Exception:
                    pass
            if cleanup:
                try:
                    os.unlink(cleanup)
                except OSError:
                    pass

    players[dev_id] = {"sonos": address, "task": asyncio.create_task(watch()), "started": time.time()}


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
    if p.get("sonos"):
        try:
            await _sonos_soap(p["sonos"], "AVTransport", "Stop", {"InstanceID": 0})
        except Exception:
            pass
        return True
    try:
        p["atv"].close()
    except Exception:
        pass
    return True


async def start_playback(dev_id: str, source: str, volume: float | None, cleanup: str | None = None):
    """Stream `source` (file path or URL) to the device as a background task."""
    async with _lock(dev_id):
        await stop_playback(dev_id)
        # Sonos renders RAOP sessions silently — use its native UPnP rail.
        addr = (speakers.get(dev_id) or {}).get("address", "")
        if addr and os.path.exists(source) and await _is_sonos(addr):
            await sonos_play(dev_id, addr, source, volume, cleanup)
            return
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


# ── UPnP IGD: find the router, read its external IP, open/close a port ───
# The "router assistant" half of direct-remote mode. Sync helpers run in a
# thread; SSDP + one XML fetch + one SOAP call are all sub-second on a LAN.
import re as _re
import urllib.request as _url

_igd: dict = {"control": None, "service": None, "at": 0.0}


def _upnp_find_sync():
    msg = (
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
        'MAN: "ssdp:discover"\r\nMX: 2\r\n'
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
    ).encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2.5)
    locations = []
    try:
        s.sendto(msg, ("239.255.255.250", 1900))
        while True:
            data, _ = s.recvfrom(4096)
            m = _re.search(rb"(?i)location:\s*(\S+)", data)
            if m:
                loc = m.group(1).decode()
                if loc not in locations:
                    locations.append(loc)
    except socket.timeout:
        pass
    finally:
        s.close()
    for loc in locations:
        try:
            xml = _url.urlopen(loc, timeout=4).read().decode("utf-8", "replace")
        except Exception:
            continue
        for svc in ("WANIPConnection:2", "WANIPConnection:1", "WANPPPConnection:1"):
            st = f"urn:schemas-upnp-org:service:{svc}"
            i = xml.find(st)
            if i < 0:
                continue
            m = _re.search(r"<controlURL>([^<]+)</controlURL>", xml[i:i + 3000])
            if not m:
                continue
            base = _re.match(r"(https?://[^/]+)", loc)
            ctrl = m.group(1) if m.group(1).startswith("http") else (base.group(1) + m.group(1))
            return {"control": ctrl, "service": st}
    return None


def _soap_sync(ctrl: str, service: str, action: str, args_xml: str) -> str:
    body = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        f'<u:{action} xmlns:u="{service}">{args_xml}</u:{action}>'
        "</s:Body></s:Envelope>"
    )
    req = _url.Request(ctrl, data=body.encode(), headers={
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": f'"{service}#{action}"',
    })
    return _url.urlopen(req, timeout=6).read().decode("utf-8", "replace")


async def upnp_gateway(force: bool = False):
    if _igd["control"] and not force and time.time() - _igd["at"] < 3600:
        return _igd
    found = await asyncio.to_thread(_upnp_find_sync)
    if found:
        _igd.update(found)
        _igd["at"] = time.time()
    else:
        _igd["control"] = None
    return _igd if _igd["control"] else None


async def h_upnp(req):
    check_token(req)
    gw = await upnp_gateway("force" in req.query)
    if not gw:
        return web.json_response({"gateway": False})
    try:
        xml = await asyncio.to_thread(_soap_sync, gw["control"], gw["service"], "GetExternalIPAddress", "")
        m = _re.search(r"<NewExternalIPAddress>([^<]+)</NewExternalIPAddress>", xml)
        return web.json_response({"gateway": True, "external_ip": m.group(1) if m else None})
    except Exception as e:
        return web.json_response({"gateway": True, "external_ip": None, "error": str(e)[:120]})


async def h_upnp_map(req):
    check_token(req)
    b = await req.json()
    port = int(b.get("port", 0))
    if not (0 < port < 65536):
        raise web.HTTPBadRequest(text="port required")
    internal = str(b.get("internal_ip") or lan_ip())
    gw = await upnp_gateway()
    if not gw:
        return web.json_response({"ok": False, "error": "no UPnP gateway — forward the port on the router manually"}, status=502)
    args = (
        "<NewRemoteHost></NewRemoteHost>"
        f"<NewExternalPort>{port}</NewExternalPort>"
        "<NewProtocol>TCP</NewProtocol>"
        f"<NewInternalPort>{port}</NewInternalPort>"
        f"<NewInternalClient>{internal}</NewInternalClient>"
        "<NewEnabled>1</NewEnabled>"
        "<NewPortMappingDescription>orb2 remote</NewPortMappingDescription>"
        "<NewLeaseDuration>0</NewLeaseDuration>"
    )
    try:
        await asyncio.to_thread(_soap_sync, gw["control"], gw["service"], "AddPortMapping", args)
        log.info("upnp: mapped TCP %d -> %s:%d", port, internal, port)
        return web.json_response({"ok": True, "port": port, "internal": internal})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)


async def h_upnp_unmap(req):
    check_token(req)
    b = await req.json()
    port = int(b.get("port", 0))
    gw = await upnp_gateway()
    if not gw:
        return web.json_response({"ok": False, "error": "no UPnP gateway"}, status=502)
    args = (
        "<NewRemoteHost></NewRemoteHost>"
        f"<NewExternalPort>{port}</NewExternalPort>"
        "<NewProtocol>TCP</NewProtocol>"
    )
    try:
        await asyncio.to_thread(_soap_sync, gw["control"], gw["service"], "DeletePortMapping", args)
        log.info("upnp: unmapped TCP %d", port)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)


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
        if p.get("sonos"):
            out["via"] = "sonos-upnp"
        else:
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

    # S1: claim orb.local — an _http._tcp service whose server name is
    # orb.local. makes the responder publish the A record, so browsers and
    # apps on the LAN resolve http://orb.local:9080 with zero setup. The
    # cooperating-responder rules mean a second orb on the network would
    # conflict; allow_name_change is not available for the host record, so
    # we just log if registration fails rather than fight over it.
    try:
        web_svc = ServiceInfo(
            "_http._tcp.local.",
            f"{name} Console._http._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=int(props["http"]),
            properties={"path": "/"},
            server="orb.local.",
        )
        await azc.async_register_service(web_svc, cooperating_responders=True)
        log.info("claimed orb.local -> %s", ip)
    except Exception as e:
        log.warning("could not claim orb.local: %s", e)

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
    # Media host for the Sonos rail (tokened, LAN-only — Sonos can't auth).
    async def h_media(req):
        path = media_files.get(req.match_info["token"])
        if not path or not os.path.exists(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Content-Type": "audio/wav" if path.endswith(".wav") else "audio/mpeg"})
    app.router.add_get("/media/{token}", h_media)
    app.router.add_get("/printer", h_printer)
    app.router.add_post("/print", h_print)
    app.router.add_get("/upnp", h_upnp)
    app.router.add_post("/upnp/map", h_upnp_map)
    app.router.add_post("/upnp/unmap", h_upnp_unmap)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("bridge listening on :%d", PORT)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
