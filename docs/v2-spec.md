# 0rb v0.2 — "The Trust Release" — Specification

*The next major version. Everything here derives from the August 2026 research
pass (home-automation state of the art, agent-product patterns, generative-UI
standards, Apple setup mechanics) mapped against what 0rb already is. Design
doctrine throughout: the Apple way — deterministic basics that never break,
physical ceremonies instead of typed credentials, one design system as the
constraint surface, accent spent only where the user can act, calm by default.*

**Version:** 0.2.0 · **Codename:** Trust · **Status: implemented 2026-08-20 — all Part I/III features at Done criteria; §11–13 scaffolded as scoped; S6 deferred as scoped**
**Definition of done:** every feature below at its stated Done criteria;
hardware-gated features (§11–13) at "scaffolded" — activation documented,
software path complete, blocked only on hardware arriving.

---

## Part I — The agent you can trust

### 1. Voice fast-path (deterministic intents before the LLM)

**Status: ✅ SHIPPED**

**Why:** Alexa+/Gemini-for-Home broke timers and lights by routing everything
through an LLM; HA's intent-first architecture is the only pattern with a good
reputation. Human turn-gap is ~200ms; users bail past ~1.2s.

**Mechanism:** a deterministic intent matcher runs on each final transcript
BEFORE the agent loop:
- Grammar: device commands (`turn on|off <device>`, `dim <device> to N`,
  `lock|unlock <lock>`), timers (`set a timer for N minutes`, `cancel the N
  timer`), house mode (`set the house to X`), volume, "stop", time/date.
- Device names resolve against the same clean HA set (`haResolve`) + bridge
  speakers; ≥1 unambiguous match required, else fall through to the LLM.
- On match: execute via existing `serviceFor`/timer/mode paths, reply with a
  short template ("Kitchen lights off."), synthesize TTS immediately. Target
  <300ms transcript→audio-start. The LLM is never invoked.
- Everything else (and any failed match) falls through unchanged.
- Fast-path replies carry `provenance:'rules'` (see §8).

**Touches:** `src/api/voice/whisperBackend.ts` (finalize hook),
new `src/api/voice/fastpath.ts`, unit tests with a transcript corpus.

**Done:** corpus test ≥30 utterances (match + correct plan + fall-through
cases); live: "turn off the living room speaker" answers without a model call
(verified via logs); zero regression in normal turns.

### 2. Consent gradient, receipts, undo, earned autonomy

**Status: ✅ SHIPPED**

**Why:** the converged 2026 agent-trust anatomy (gradient of consent, evidence
cards, receipts with undo, progressive delegation) — nobody ships it for the
physical home.

**Mechanism:**
- **Action classes.** Every native tool op gets `impact`:
  `read` | `reversible` | `confirm` | `never-auto`. Defaults: all Home/AirPlay
  playback + lights + media = reversible; lock/unlock, mode `secure`,
  Print, purchases-adjacent (Shopping checkout handoff already never-claims),
  self-evolution = confirm. Stored in a policy map
  (`src/api/policy/actions.ts`) — per-class user overrides persisted in kv
  (`policy:overrides`).
- **Receipts ledger.** Every state-changing tool execution appends
  `{ts, user, tool, op, entity, summary, inverse?}` to a capped kv ring
  (`receipts:ring`, 500 entries). Inverse actions where derivable:
  light on↔off (with previous brightness), mode X→previous, volume→previous,
  lock↔unlock (confirm-classed), timer cancel→recreate.
- **Receipts surface.** New widget `receipts` (attention tier: glance) +
  `GET /v1/receipts` + an **Undo** button per entry with an inverse. The agent
  gets a `Receipts` tool (`op:'list'|'undo'`); voice: "undo that" hits the
  fast-path → last inverse.
- **Approval cards.** `confirm`-class actions executed by the agent emit a
  `review` card (widget type `approval`: action, reason, evidence, expected
  outcome, Approve/Cancel) and block the tool call on a short-lived approval
  token (`POST /v1/approvals/:id`), timing out to cancel in 120s. Voice
  approval ("yes, do it") accepted from the SAME speaker (§4).
- **Earned autonomy.** Per (user, tool+op) approval counter; at 3 approvals
  the next card offers "Always allow — I'll show a receipt instead"; grants
  recorded in `policy:overrides`, listed and revocable in Settings → Users →
  <member> and mentioned in the receipt.

**Done:** policy map covers every mutating native tool; receipts render +
undo works live (light toggle round-trip); approval card blocks and resumes a
confirm-class action E2E; autonomy grant persisted + revocable; tests for
ledger, inverse derivation, approval timeout.

### 3. The morning deck (proactive digest done the calm way)

**Status: ✅ SHIPPED**

**Why:** ChatGPT Pulse proved the overnight card-deck; orb has the pieces
(briefing, scheduler, memory, widgets) and the trust layer (§2) to do it
without being creepy.

**Mechanism:**
- Nightly job (05:30 local, existing proactive scheduler) assembles a
  **deck** per member: weather, calendar today, house anomalies (unclosed
  doors, low batteries), open threads (undelivered notes, running timers),
  chores due, and ONE memory-derived follow-up ("you asked me to remind you
  about the dentist rebooking").
- Deck = ordered list of ordinary widget specs + a `deck` wrapper widget
  (swipe/scroll card stack, thumbs-up/down + dismiss per card).
- Feedback writes `deck:feedback:<user>` and biases next assembly (naive
  scoring first: −2 per thumbs-down topic, +1 per thumbs-up; topics tagged at
  assembly).
- Delivery: waiting on the console/kiosk at first interaction after 05:30
  (never a push by default); optional push per user setting.

**Done:** deck assembles from ≥4 live sources; renders as stack; feedback
persists and demonstrably reorders next assembly (test with seeded feedback);
per-user; no LLM required for assembly (template + data), LLM optional for
the one narrative line.

### 4. Per-person memory bound to voice

**Status: ✅ SHIPPED**

**Why:** two-layer memory (auto profile + pinned facts) per member, selected
by on-device speaker-ID — the fully-local version of what Alexa/Google do in
the cloud; nobody self-hosted does it.

**Mechanism:**
- Memory namespacing: memory writes/reads gain a `member` scope. Voice turns
  bind scope from speaker-ID match (≥ threshold, existing ECAPA stack);
  console/app turns bind from session identity. Unknown speaker → household
  scope (shared), never another member's.
- **Pinned facts:** `Remember` tool gains `scope:'me'|'household'`;
  "remember that *I* prefer..." → member scope.
- **Profile digest:** the existing dream/consolidation job produces
  per-member digests (facts observed from that member's turns) alongside the
  household digest.
- **"What orb knows" screen:** Settings → Users → member → *Memory*: the
  digest (read-only prose), pinned facts (delete per row), voice profile
  (re-enroll / delete), autonomy grants (§2), presence status. Apple-privacy
  tone: everything visible, everything deletable.
- Approval-by-voice (§2) requires the binding speaker to match the acting
  member.

**Done:** two members with distinct pinned facts get distinct answers to "what
do you know about me"; deletion works; voice binding selects the right scope
(test via seeded embeddings); screen ships.

### 5. Streaming, skeleton-first widgets + versioned catalog

**Status: ✅ SHIPPED**

**Why:** perceived latency is the whole game (Google GenUI's >1min full-page
gen is the cautionary tale). The catalog-as-constraint IS the A2UI/MCP-Apps
security model — formalize ours.

**Mechanism:**
- **Catalog manifest:** generate `web/public/catalog.json` (build step) from
  the widget registry: type, schema of accepted fields, attention tier (§10),
  version hash. The system prompt embeds type names + one-line field hints +
  version (`CATALOG v<hash>`).
- **Skeleton streaming:** `emitWidget` gains an optional two-phase form: the
  agent (or tool) may emit `{id, type, title, pending:true}` immediately, then
  the full spec. Shell renders a skeleton card (title + shimmer) that fills
  in place. Native tools that do slow work (Blender, WebSearch→results,
  camera) adopt it.
- **Validation:** emitWidget validates spec fields against the catalog schema
  (strip unknown fields, log rejects) — model-authored specs can't smuggle
  arbitrary HTML outside `html`-typed widgets (which stay sandboxed, §14).

**Done:** catalog.json generated + embedded in prompt; ≥3 slow tools emit
skeleton-first; validation rejects a malformed spec in tests; no visual
regression in the gallery (43/43).

### 6. Malleable, persistent widgets + composed home screen

**Status: ✅ SHIPPED**

**Why:** Ink & Switch malleability: adaptation at the point of use, as spec
diffs over shared data — not regeneration. And the kiosk should compose itself.

**Mechanism:**
- **Pinning:** any widget gets a pin affordance (and "pin this" via agent →
  new `Pin` op on Widget tool). Pinned specs persist per member:
  `pins:<user>` = [{spec, layout hints, pinnedAt}].
- **Edit-by-diff:** "make the weather card show humidity" → the agent emits
  the SAME id with the amended spec; because it's pinned, the stored spec
  updates (versioned, last 5 kept, revert via receipts).
- **Composed home screen:** kiosk/idle console renders the member's pins +
  contextual autos (morning: deck; evening: house status; someone at door:
  camera) via a composition function (rules first, LLM optional later).
  Widgets carry `context` hints (time-of-day relevance) in the catalog.
- Live data: pinned widgets refresh through their existing refresh paths
  (home devices poll, timers tick); specs store *queries* not snapshots where
  the type supports it.

**Done:** pin → survives reload + appears in kiosk; edit-by-diff updates the
pinned spec; two members see different pin sets; composition switches
morning/evening layouts (clock-driven test).

### 7. Matter controller (commission devices directly)

**Status: ✅ SHIPPED (IP commissioning; BLE best-effort as scoped)**

**Why:** today orb bridges OUT to Apple Home; the controller role lets orb
ADOPT Matter devices itself — scan code, device joins orb, no HA required for
simple devices. Matter 1.4.1 multi-QR + 1.6 NFC/Joint-Fabric make this the
future of device onboarding.

**Mechanism:**
- matter.js controller in the existing `matter` sidecar (it already has host
  networking + storage): `POST /commission {code}` (QR `MT:` payload or
  11-digit), `GET /nodes`, `POST /node/:id/command`.
- Commissioning transport: **IP-first** (device already on network /
  ethernet); BLE commissioning attempted when the host adapter allows —
  RISK: the box's BT adapter is flaky (HA shows setup_retry) → BLE is
  best-effort, documented.
- Adopted devices surface exactly like HA devices: mapped into
  `/v1/matter/…` snapshot → Home tool + widgets + receipts, tagged
  `via:'matter'`.
- Add-device flow (§S5) routes Matter codes here.

**Done:** commission a Matter device over IP end-to-end in a test harness
(virtual device via matter.js example node on the LAN); adopted node
controllable through the Home tool; graceful "needs BLE, not available"
message otherwise.

### 8. Three-tier routing + provenance badges

**Status: ✅ SHIPPED**

**Why:** Apple's on-device / private-cloud / frontier split is the canonical
pattern; orb can mirror it exactly and make it VISIBLE.

**Mechanism:**
- Tiers: `rules` (§1 fast-path + widget refresh paths), `local` (vLLM),
  `cloud` (explicit router escalation, existing smart router).
- Every chat/voice reply event carries `provenance:{tier, model?}`; the
  console renders a quiet badge on the message row (dot + "local" /
  "cloud" / nothing for rules since it's instant) — metadata-grade, inkDim,
  never colored.
- Settings → General → Brain shows the live counts (turns by tier, 7 days).

**Done:** badges render for local + cloud turns; counter accurate in a
scripted mixed session; fast-path replies logged as rules-tier.

### 9. Routines (user-visible scheduled agents)

**Status: ✅ SHIPPED**

**Why:** scheduled/background agents are table stakes (Tasks/Pulse/Routines);
orb's engine is half-built (care routines) but invisible.

**Mechanism:**
- `Routine` = {id, owner, schedule (cron-lite: daily/weekly/interval),
  instruction (natural language), delivery: cards|push|voice-announce,
  enabled}. Stored in kv; executed by the proactive scheduler via a normal
  agent turn with the owner's identity + member memory scope; outputs flow
  through the ambient-card taxonomy: **notify** (FYI card), **question**
  (blocked, one input), **review** (approval card, §2).
- Agent tool `Routines` (create/list/pause/delete) — "every Sunday at 5pm,
  plan the week's meals and put them on the family board".
- Settings → Users → member → Routines lists them (pause/delete); receipts
  log each run.

**Done:** create-by-voice works; a routine fires on schedule (test with
1-minute interval), produces cards, logs a receipt; pause/delete works;
per-member scoping correct.

### 10. Attention tiers + ambient surfaces

**Status: ✅ SHIPPED**

**Why:** calm technology — every widget declares how much attention it may
claim; the renderer maps tiers to surfaces. Interruption must be earned.

**Mechanism:**
- Catalog gains `attention: 'ambient'|'glance'|'notify'|'interrupt'` per
  type (+ per-spec override, validated).
- Mapping today: ambient → kiosk idle board (no motion, slow refresh);
  glance → floating card, no sound; notify → card + chime + push
  (existing notifyOwner path); interrupt → voice announcement (AirPlay/TTS)
  — only §2 `confirm`-worthy events and explicit user asks may use it.
- Kiosk ambient board = §6 composition restricted to ambient/glance tiers,
  dimming preserved.
- **E-ink surface: scaffolded** — `GET /v1/ambient/board.png` renders the
  member's ambient board server-side (Playwright already in the toolchain →
  headless snapshot) at configurable resolution/grayscale for TRMNL-class
  displays. Hardware validation deferred until a device exists.

**Done:** tiers in catalog + enforced (a `notify` widget cannot voice-
announce); kiosk uses tier filtering; board.png endpoint returns a rendered
grayscale board.

---

## Part II — Hardware-gated scaffolds

### 11. Energy intelligence (scaffold)

**Status: ✅ SCAFFOLDED (op + widget + docs; awaits metering hardware)**
Snapshot schema + Home op `energy` + widget already-designed against Matter
1.3/1.5 power/tariff clusters and HA energy entities; activates when metering
hardware exists. Done = schema + empty-state widget + docs.

### 12. Camera intelligence (scaffold)

**Status: ✅ SCAFFOLDED (ask op wired to HA cameras + vision brain; awaits a camera)**
`AI-Task` pattern: `Home op:'camera'` gains `ask:"is the package there?"` →
frame → multimodal brain (vision path exists). Done = op wired against HA
camera entities (testable the day a camera exists) + docs. Matter 1.5 camera
adoption noted for §7 future.

### 13. mmWave presence (doc only)

**Status: ✅ DONE (docs §7d in SETUP-AND-INTEGRATIONS)**
Recommended hardware (FP2-class / LD2410-ESPHome), integration path via HA →
existing presence merge. Done = docs section.

### 14. CreateWidget v2 sandbox (MCP-Apps contract)

**Status: ✅ SHIPPED**
Runtime-minted widgets and `html` widgets render in an iframe with
`sandbox="allow-scripts"`, locked CSP (no external network), postMessage-only
bridge for the widget bus. Aligns with MCP Apps 2026-01-26. Done = sandboxed
render path + one minted widget passing the gallery.

---

## Part III — Setup & onboarding

### S1. orb.local + one-liner

**Status: ✅ SHIPPED (orb.local claimed via bridge mDNS)**
Bridge sidecar additionally registers hostname `orb.local` (zeroconf address
record) → console reachable at http://orb.local:9080. Install docs lead with
`curl -fsSL https://orb2.app/install | bash` (relay serves the script,
redirecting to the repo installer). Done = orb.local resolves on LAN; script
served.

### S2. Claim ceremony (scan instead of type)

**Status: ✅ SHIPPED**
First-run (no users yet) console shows a **QR** encoding
`orb2-claim://<host>/<code>` (code = short-lived, single-use, from the api).
The phone app's enrollment adds "Scan the code on your orb's screen" —
scanning binds: app POSTs the code → api creates the owner from the app-side
email (typed once on the phone, where typing is native) → session minted.
Emailed OTP remains the fallback rung. Done = E2E: fresh kv → QR shown →
app-scan flow mints owner (simulated via curl for the code exchange + app
code paths written).

### S3. Narrated first-run

**Status: ✅ SHIPPED**
After owner claim, the orb SPEAKS (if voice available) and posts a first-run
card sequence: name the orb → who lives here (add members) → "I found these
on your network" (bridge devices + HA discoveries) — each optional,
dismissible, resumable from Settings. No wizard walls. Done = first-run
sequence renders on fresh install; every step skippable; state persisted.

### S4. Backup & migration

**Status: ✅ SHIPPED**
Settings → General → Backup: one-tap **encrypted export** (kv namespaces:
users, memory, pins, policy, routines, matter fabric + devicecert identity;
AES-256-GCM, passphrase) downloaded as `.orbbackup`; Restore accepts it on a
fresh install (pre-claim) or same-owner instance. Matter fabric restore keeps
Apple Home pairing. Done = round-trip test: export → wipe test namespace →
import → state identical (scripted).

### S5. Unified Add Device flow

**Status: ✅ SHIPPED (console; app camera-scan path next app release)**
Apps + console: one "Add device" entry → camera scan → payload sniffing:
`MT:` → §7 controller (or HA fallback while controller is IP-only);
HomeKit `X-HM://` → guidance; otherwise → HA discovery/setup flows (existing,
humanized). Progress narrated (voice + card). Named failures: detect phone on
5GHz vs device 2.4-only where determinable; always name the failing step.
Done = scan-routing implemented in both apps + console manual-code path;
failure copy reviewed.

### S6. Remote relay rung — **DEFERRED** (see Blockers)

---

## Part IV — Blocker & risk pass (second-pass findings)

1. **S6 relay**: Vercel functions cannot host a TCP/WebSocket relay
   (serverless, no long-lived connections). A true QuickConnect-style relay
   needs a persistent host (fly.io/VPS). **Deferred from 0.2**; the ladder
   already has tailscale/funnel + DynDNS. Revisit as infra decision.
2. **§7 BLE commissioning**: host BT adapter is unreliable (HA setup_retry
   observed). Scope: IP commissioning REQUIRED, BLE best-effort behind a
   capability probe. Most retail Matter devices commission via BLE → v1
   controller mainly proves the path (virtual/IP devices, ethernet devices);
   the phone apps (which have BLE) are the long-term commissioners — noted
   as 0.3 follow-up (app-side commissioning via native Matter APIs).
3. **§4 speaker-binding security**: voice-ID is biometric-ish but spoofable;
   approval-by-voice for `confirm` actions requires match ≥ high threshold
   AND falls back to console approval on low confidence. Never-auto class
   cannot be voice-approved.
4. **§1 fast-path ambiguity**: name collisions ("living room" = speaker AND
   area) must fall through to the LLM rather than guess wrong — the matcher
   requires unique resolution; corpus tests must include collision cases.
5. **§5 prompt size**: embedding the full catalog schema would bloat the
   system prompt; embed type names + terse hints only (~600 tokens), full
   schemas live server-side for validation.
6. **§6 refresh semantics**: only types with a server refresh path (home,
   timers, weather, presence, receipts, deck) can live-refresh when pinned;
   others render last snapshot + staleness stamp — catalog gains
   `refresh:'live'|'snapshot'`.
7. **§9 runaway routines**: cap runs (max 1 concurrent, 20/day/member),
   receipts every run, auto-pause after 3 consecutive failures.
8. **S2 claim security**: claim QR only served while NO owner exists (or
   from an authenticated owner session for adding members); code TTL 10 min,
   single use, rate-limited.
9. **S4 crypto**: AES-256-GCM with scrypt KDF; matter fabric keys included —
   document that the backup file is equivalent to house keys.
10. **Ordering**: §2 (policy/receipts) is foundational — §1, §7, §9 all log
    through it; build first. §5 catalog precedes §6/§10 (schema carrier).
11. **Out of scope for 0.2** (explicit): app-store distribution, wake word on
    iOS, Joint Fabric (spec 1.6 — matter.js support immature), relay infra,
    homeOS anything (no SDK).

**Build order:** §2 → §1 → §5 → §10 → §6 → §3 → §4 → §8 → §9 → §14 → S1 →
S2 → S3 → S4 → S5 → §7 → scaffolds (§11–13).
