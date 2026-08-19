/**
 * 0rb Matter bridge — exposes orb's world into Apple Home (and any Matter
 * controller): every HA light and switch, an "Away Mode" switch, and one
 * occupancy sensor per family member. Pair once from the Home app (manual
 * code shown in Settings → Smart home) and Siri controls everything on
 * every Apple device — no certification needed for self-hosted use
 * (Apple shows "uncertified accessory → Add Anyway").
 *
 * Runs on the host network (Matter commissioning is mDNS + UDP). State
 * flows: orb2-api /v1/matter/snapshot (poll) → Matter attributes; Matter
 * commands → /v1/matter/control | /v1/matter/mode.
 */
import http from "node:http";
import { Endpoint, Environment, ServerNode } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import {
  DimmableLightDevice, OnOffLightDevice, OnOffPlugInUnitDevice, OccupancySensorDevice,
  TemperatureSensorDevice, HumiditySensorDevice, ContactSensorDevice, DoorLockDevice,
} from "@matter/main/devices";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";

const API = (process.env.ORB2_API_URL || "http://127.0.0.1:9080").replace(/\/+$/, "");
const TOKEN = process.env.ORB2_MATTER_TOKEN || "";
const PORT = Number(process.env.ORB2_MATTER_HTTP_PORT || 8998);
const POLL_MS = 5000;

const headers = { "content-type": "application/json", ...(TOKEN && { "x-matter-token": TOKEN }) };

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// ── Matter node ──────────────────────────────────────────────────────────
const environment = Environment.default;
environment.vars.set("storage.path", process.env.ORB2_MATTER_STORAGE || "/data");

const node = await ServerNode.create({
  id: "orb2-matter-bridge",
  network: { port: 5540 },
  productDescription: { name: "0rb Bridge", deviceType: AggregatorEndpoint.deviceType },
  basicInformation: {
    vendorName: "0rb",
    productName: "0rb Matter Bridge",
    vendorId: 0xfff1,
    productId: 0x8001,
    uniqueId: "orb2-bridge-1",
    serialNumber: "orb2-0001",
  },
});

const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await node.add(aggregator);

// entity_id → { ep, kind, lastOn, lastLevel } — lastX suppress echo loops:
// our own state pushes fire the same $Changed events as real commands.
const bridged = new Map();
let lastPeople = new Map();
let lastAway = null;

const safeId = (s) => s.replace(/[^A-Za-z0-9]/g, "_").slice(0, 48);
const label = (s) => String(s || "device").slice(0, 32);

async function addDevice(d) {
  const kind = d.domain === "light" ? (d.brightness !== null ? "dimmable" : "light") : "plug";
  const Dev = kind === "dimmable" ? DimmableLightDevice : kind === "light" ? OnOffLightDevice : OnOffPlugInUnitDevice;
  const ep = new Endpoint(Dev.with(BridgedDeviceBasicInformationServer), {
    id: safeId(d.entity_id),
    bridgedDeviceBasicInformation: { nodeLabel: label(d.name), reachable: true },
  });
  await aggregator.add(ep);
  const entry = { ep, kind, lastOn: d.on, lastLevel: d.brightness };
  bridged.set(d.entity_id, entry);

  ep.events.onOff.onOff$Changed.on((v) => {
    if (v === entry.lastOn) return;                    // our own push
    entry.lastOn = v;
    api("/v1/matter/control", { entity_id: d.entity_id, action: v ? "on" : "off" })
      .catch((e) => console.warn("control failed:", d.entity_id, e.message));
  });
  if (kind === "dimmable") {
    ep.events.levelControl.currentLevel$Changed.on((lvl) => {
      const pct = Math.round(((lvl ?? 1) / 254) * 100);
      const lastPct = entry.lastLevel != null ? Math.round((entry.lastLevel / 255) * 100) : null;
      if (lastPct !== null && Math.abs(pct - lastPct) <= 1) return;
      entry.lastLevel = Math.round((pct / 100) * 255);
      api("/v1/matter/control", { entity_id: d.entity_id, action: "set", value: pct })
        .catch((e) => console.warn("dim failed:", d.entity_id, e.message));
    });
  }
  console.log(`bridged: ${d.name} (${d.entity_id}) as ${kind}`);
}

// Away-mode switch — Siri: "turn on Away Mode".
let awayEp = null;
async function addAwaySwitch() {
  awayEp = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), {
    id: "orb2_away_mode",
    bridgedDeviceBasicInformation: { nodeLabel: "Away Mode", reachable: true },
  });
  await aggregator.add(awayEp);
  awayEp.events.onOff.onOff$Changed.on((v) => {
    if (v === lastAway) return;
    lastAway = v;
    api("/v1/matter/mode", { away: v }).catch((e) => console.warn("mode failed:", e.message));
  });
}

// Locks — Siri: "lock the front door" (Home asks for confirmation to unlock).
const lockEps = new Map();   // entity_id -> { ep, lastLocked }
async function addLock(l) {
  const ep = new Endpoint(DoorLockDevice.with(BridgedDeviceBasicInformationServer), {
    id: safeId(l.entity_id),
    bridgedDeviceBasicInformation: { nodeLabel: label(l.name), reachable: true },
    doorLock: { lockState: l.locked ? 1 : 2, lockType: 2, actuatorEnabled: true },
  });
  await aggregator.add(ep);
  const entry = { ep, lastLocked: l.locked };
  lockEps.set(l.entity_id, entry);
  ep.events.doorLock.lockState$Changed.on((state) => {
    const locked = state === 1;
    if (locked === entry.lastLocked) return;   // our own push
    entry.lastLocked = locked;
    api("/v1/matter/control", { entity_id: l.entity_id, action: locked ? "lock" : "unlock" })
      .catch((e) => console.warn("lock control failed:", l.entity_id, e.message));
  });
  console.log(`bridged lock: ${l.name}`);
}

// Read-only environment sensors: temperature, humidity, door/window contact.
const sensorEps = new Map(); // entity_id -> { ep, kind, last }
async function addSensor(s) {
  const Dev = s.kind === "temperature" ? TemperatureSensorDevice
    : s.kind === "humidity" ? HumiditySensorDevice : ContactSensorDevice;
  const init = { id: safeId(s.entity_id), bridgedDeviceBasicInformation: { nodeLabel: label(s.name), reachable: true } };
  if (s.kind === "temperature") init.temperatureMeasurement = { measuredValue: Math.round(s.value * 100) };
  else if (s.kind === "humidity") init.relativeHumidityMeasurement = { measuredValue: Math.round(s.value * 100) };
  else init.booleanState = { stateValue: s.value === 0 };   // Matter: true = closed
  const ep = new Endpoint(Dev.with(BridgedDeviceBasicInformationServer), init);
  await aggregator.add(ep);
  sensorEps.set(s.entity_id, { ep, kind: s.kind, last: s.value });
  console.log(`bridged sensor: ${s.name} (${s.kind})`);
}

async function setSensor(entry, value) {
  if (value === entry.last) return;
  entry.last = value;
  const patch = entry.kind === "temperature" ? { temperatureMeasurement: { measuredValue: Math.round(value * 100) } }
    : entry.kind === "humidity" ? { relativeHumidityMeasurement: { measuredValue: Math.round(value * 100) } }
    : { booleanState: { stateValue: value === 0 } };
  await entry.ep.set(patch).catch(() => {});
}

const peopleEps = new Map();
async function addPerson(name, home) {
  const ep = new Endpoint(OccupancySensorDevice.with(BridgedDeviceBasicInformationServer), {
    id: `person_${safeId(name)}`,
    bridgedDeviceBasicInformation: { nodeLabel: label(`${name} Home`), reachable: true },
    occupancySensing: { occupancy: { occupied: !!home } },
  });
  await aggregator.add(ep);
  peopleEps.set(name, ep);
  console.log(`bridged person: ${name}`);
}

// ── sync loop ────────────────────────────────────────────────────────────
async function sync() {
  let snap;
  try { snap = await api("/v1/matter/snapshot"); } catch (e) {
    console.warn("snapshot failed:", e.message);
    return;
  }
  for (const d of snap.devices || []) {
    let entry = bridged.get(d.entity_id);
    if (!entry) {
      try { await addDevice(d); } catch (e) { console.warn("add failed:", d.entity_id, e.message) }
      continue;
    }
    if (d.on !== entry.lastOn) {
      entry.lastOn = d.on;
      await entry.ep.set({ onOff: { onOff: d.on } }).catch(() => {});
    }
    if (entry.kind === "dimmable" && d.brightness !== null && d.brightness !== entry.lastLevel) {
      entry.lastLevel = d.brightness;
      const lvl = Math.max(1, Math.min(254, Math.round((d.brightness / 255) * 254)));
      await entry.ep.set({ levelControl: { currentLevel: lvl } }).catch(() => {});
    }
  }
  for (const l of snap.locks || []) {
    const entry = lockEps.get(l.entity_id);
    if (!entry) {
      try { await addLock(l); } catch (e) { console.warn("lock add failed:", e.message) }
      continue;
    }
    if (l.locked !== entry.lastLocked) {
      entry.lastLocked = l.locked;
      await entry.ep.set({ doorLock: { lockState: l.locked ? 1 : 2 } }).catch(() => {});
    }
  }
  for (const s of snap.sensors || []) {
    const entry = sensorEps.get(s.entity_id);
    if (!entry) {
      try { await addSensor(s); } catch (e) { console.warn("sensor add failed:", e.message) }
      continue;
    }
    await setSensor(entry, s.value);
  }
  const away = snap.mode === "away" || snap.mode === "vacation";
  if (awayEp && away !== lastAway) {
    lastAway = away;
    await awayEp.set({ onOff: { onOff: away } }).catch(() => {});
  }
  for (const p of snap.people || []) {
    if (!peopleEps.has(p.name)) {
      try { await addPerson(p.name, p.home); } catch (e) { console.warn("person add failed:", e.message) }
      continue;
    }
    if (lastPeople.get(p.name) !== p.home) {
      await peopleEps.get(p.name).set({ occupancySensing: { occupancy: { occupied: !!p.home } } }).catch(() => {});
    }
    lastPeople.set(p.name, p.home);
  }
}

// ── status HTTP (pairing code for the Settings card) ─────────────────────
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") { res.end(JSON.stringify({ ok: true, devices: bridged.size })); return; }
  if (req.url === "/pairing") {
    let out = { commissioned: false };
    try {
      const c = node.state.commissioning;
      out.commissioned = !!c.commissioned;
      if (!c.commissioned) {
        const codes = c.pairingCodes;
        out.manualCode = codes.manualPairingCode;
        out.qrCode = codes.qrPairingCode;
      }
      out.fabrics = Object.keys(c.fabrics ?? {}).length;
    } catch (e) { out.error = String(e.message).slice(0, 120); }
    out.devices = bridged.size;
    res.end(JSON.stringify(out));
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
}).listen(PORT, () => console.log(`matter status api on :${PORT}`));

// ── run ──────────────────────────────────────────────────────────────────
await addAwaySwitch();
await sync().catch(() => {});
setInterval(() => { sync().catch(() => {}); }, POLL_MS);
await node.start();
console.log("matter bridge running; commissioned:", node.state.commissioning.commissioned);
if (!node.state.commissioning.commissioned) {
  const codes = node.state.commissioning.pairingCodes;
  console.log("pair with Apple Home — manual code:", codes.manualPairingCode);
}
