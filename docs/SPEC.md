# The 0rb Spec — "Hands"

**THE single working specification.** Everything not yet built lives here
and nowhere else; when a section ships, its checkbox flips and its Done
criteria become regression tests. Prior specs are archived in git history
(the v0.2 "Trust" spec shipped in full on 2026-08-20 — its record is
summarized in Part 0). The narrative north star is **playbook.md**; where
the playbook says ⏳, this spec says how.

*From the house that runs itself (Trust) to the life that runs itself
(the playbook): the orb acts in the world — food, rides, restocking,
gifts, bookings, returns — and follows you out of the house. Design
doctrine unchanged: deterministic basics, honest mechanisms, every action
classified → approved → receipted, money never lies about reversibility.*

**Codename:** Hands · **Releases:** each build-order stage ships as the
next `v26.N` calendar release (VERSIONING.md), tagged, docs updated.
**Definition of done:** every § at its stated Done criteria; mechanisms
marked *handoff* are done when the cart→human-tap→watch loop closes; the
sim-commerce harness (Part V) proves every flow without a real dollar
moving.

---

## Part 0 — Shipped foundation (build on, don't rebuild)

Everything below is LIVE as of v26.6 (the "Trust" release plus its
follow-ons) — reference implementations, not open work:

- **Trust layer** — consent gradient (read/reversible/confirm/never-auto)
  at the tool choke point, approval cards, receipts ring with captured
  inverses + real Undo, earned autonomy (3 approvals → offer).
- **Voice** — deterministic fast-path before the LLM (devices, timers,
  modes, undo; ~14 ms), barge-in, streaming TTS, speaker ID.
- **Widgets** — versioned 49-type catalog, attention tiers, validation on
  emit, pinning w/ history, composed board, dedicated TV + Spotify
  widgets, CSP-locked plugin sandbox, skeleton streaming.
- **Memory v2** — files (household + per-member + people), episodes,
  learning dream (extract + date + supersede), auto-recall w/ salience.
- **Household** — profiles (names/avatars/invites), per-member app
  permissions w/ graceful denial, morning deck (sunrise-gated,
  per-member topics), routines (visible scheduled agents), family board,
  presence/geofence + arrival flows.
- **Home** — HA deep control + humanized setup, AirPlay/IPP direct-first,
  Matter bridge (Apple Home/Siri) AND controller (adopt by MT: code),
  unified Add Device, house modes + secure sweep, **sim device fleet**
  (lights/lock/sensors) keeping every path regression-tested.
- **Accounts** — hub + orb2.app relay: one-tap OAuth (Spotify live;
  Google/MS pending app registration), per-member sealed tokens, popup
  completion immune to DNS-rebind, Apple via CalDAV app-password.
- **Onboarding & ops** — claim ceremony, narrated first-run, orb.local,
  encrypted .orbbackup (incl. Matter fabric), tailscale/DynDNS remote,
  calendar versioning + CI version guard, Playwright suites (smoke,
  49-widget gallery, user flows), 170 unit tests.
- **Apps v1** — iOS + Android: discovery, OTP, chat/widgets, kiosk,
  App Intents/shortcuts, wake word. Push relay server-side built;
  **client push blocked on google-services/billing (P-1)**.

**Gaps this spec closes:** no money model, no service connectors, no
order lifecycle, no event journal, no away surface, no camera memory, no
consumption tracking, no notification router beyond notifyOwner.

---

## Part I — Foundations (everything else depends on these)

### 1. Budget & spend policy engine (trust layer, extended to money)

**Status: ✅ shipped (v26.8)** — authorizeSpend choke point, tiers/caps/earned ladder unit-tested, Budgets UI live

**Why:** money must enter the SAME gradient as door locks, or nothing else
in this spec is safe to ship.

**Data model** (kv):
- `spend:policy` — `{ categories: { food: { askUnder: 60, neverOver: 120,
  tier: 'ask'|'earned'|'never' }, rides: {...}, consumables: {...},
  gifts: { tier: 'always-ask' }, other: {...} }, weeklyCap: 400,
  currency: 'USD' }` — owner-editable, defaults conservative.
- `spend:week:<ISO-week>` — `{ total, byCategory }` counters, updated on
  every placed order; the weekly hard stop reads this.
- `spend:earned:<category>` — approval streak (mirrors autonomy: 3
  consecutive approvals in a category+service ⇒ offer auto-tier under
  `askUnder`; revocation identical to action autonomy).
- Per-member: `disabled_apps` gains `commerce` group; a member's order
  intents are ALSO capped by `profiles` (child profile ⇒ no ordering,
  graceful message per Profiles v2 rules).

**Mechanism:** a single `authorizeSpend(store, member, {category, amountCents,
service, summary})` choke point in `src/api/commerce/policy.ts`:
returns `auto` | `needs-approval` | `refused(reason)`. Called by every
connector BEFORE any cart is finalized. Approval reuses the v0.2 approval
card (adds amount + category + budget line "counts against food:
$87/$120 this week"). Weekly cap breach refuses with the exact numbers.

**Receipts:** spend receipts extend the ring entry: `{ amountCents,
category, service, orderId, reversibility: 'refund-path', refundState? }`.
Undo on a spend receipt does NOT claim reversal — it opens the refund path
(§10) and says so.

**UI:** Settings → Users → household **Budgets** card (owner-only):
category rows with askUnder / neverOver / tier, weekly cap, this-week
meter. Deck: monthly **spend audit** card (§10). Console approval card
variant shows amount prominently.

**Touches:** `src/api/commerce/policy.ts` (new), policy.ts receipts ring
(field extension), apiNativeTools approval flow reuse, Settings UI,
deck card builder.

**Done:** unit-tested tier ladder (ask→earned→auto, refusal at caps,
member-profile refusal); a sim-commerce order walks every branch; budgets
UI edits persist; spend receipts render with refund-path wording.

### 2. Service-connector framework

**Status: ✅ shipped (v26.9)** — registry + sim connectors (api & handoff), fuzzy resolution, /v1/commerce/services

**Why:** ten services must feel like one drawer; adding the eleventh must
be a file, not a project.

**Interface** (`src/api/commerce/connector.ts`):
```ts
interface ServiceConnector {
  id: 'uber'|'ubereats'|'lyft'|'doordash'|'instacart'|'amazon'|'digikey'|
      'mcmaster'|'opentable'|'flowers'|'pharmacy'|...
  label: string; category: SpendCategory
  mechanism: 'api'|'handoff'|'watch'
  link: 'relay-oauth'|'credentials'|'none'      // how a member connects
  capabilities: { search?, cart?, order?, track?, cancel? }
  // api-mechanism connectors implement these; handoff implements cart→url
  buildCart(store, member, intent): Promise<Cart>
  checkoutUrl?(cart): string                     // handoff deep-link
  placeOrder?(store, member, cart): Promise<OrderRef>   // api only
  track?(store, member, ref): Promise<OrderStatus>
}
```
Registry pattern mirrors APP_GROUPS. Linking reuses the relay
(provider entries added to orb2.app `_relay.js` where OAuth exists —
Uber) or per-member credential storage (`service:cred:<id>:<member>`,
AES at rest via existing kv) where it's login-based. Settings → Apps →
Your accounts renders connectors from the registry with the same brand
rows, mechanism badge ("one-tap" / "cart handoff" / "tracking only").

**Agent tools:** one `Order` tool (op: options|cart|place|status|cancel,
service?, intent) + `Ride` tool (§6) + existing Shopping absorbs
replenishment. Tool descriptions teach the calculus pattern ("present
options with time+cost, never place without §1 authorization").

**Touches:** `src/api/commerce/` (new module tree), relay `_relay.js`
provider additions, Settings accounts card, apiNativeTools.

**Done:** registry drives Settings rendering; a mock connector (sim,
§16) links, builds a cart, and round-trips an order end to end through
`authorizeSpend`; per-member links verified (two members, two carts).

### 3. Order lifecycle & the cart/handoff engine

**Status: ✅ shipped (v26.9)** — full state machine, Order tool, order widget, proactive tracking, handoff never claims placement; E2E green in console

**Why:** the difference between "I ordered" and the truth is a state
machine.

**Data model:** `order:<id>` — `{ id, member, service, category, state:
'draft'|'awaiting-payment'|'placed'|'in-progress'|'delivered'|'canceled'|
'refund-pending'|'refunded', cart: {items[], subtotal, fees, total},
placedAt?, eta?, tracking?, receiptId, source: 'api'|'handoff'|'mail' }`.
Index `orders:open` for the loop. TTL: closed orders archive to the
receipts ring reference after 90 days.

**Handoff flow (the honest core):** connector builds cart →
`authorizeSpend` → console/phone shows the **filled checkout** (deep link
or connector-rendered summary + "Open checkout" button) → human taps Pay
in the merchant surface → orb detects placement via §10 mail parse (or
user confirm) → state `placed`, receipt written with total. The orb NEVER
claims placement it didn't observe; `awaiting-payment` orders nag once,
then expire.

**API-mechanism flow:** placeOrder directly after authorization; webhook/
poll for status where offered.

**Courier orchestration (food):** on `in-progress` with courier ETA: gate
code message hook (connector metadata), porch light rule (dusk-aware),
single chime on `delivered` (attention tier: notify). All optional per
household setting.

**Touches:** `src/api/commerce/orders.ts`, proactive loop (order polling
lane), widgets: `order` widget type (status card: items, state timeline,
track link, cancel/refund button), catalog +1.

**Done:** sim connector walks draft→delivered and draft→refund; handoff
flow verified in console (checkout button opens, confirm closes loop);
order widget in gallery; open orders survive api restart.

### 4. Event journal & notification router v2

**Status: ✅ shipped (v26.8)** — journal ring + writers (receipts/mode/presence/routines), /v1/journal, prefs; push leg degrades to digest until P-1

**Why:** both the away-timeline (§11) and sane notifications need one
stream of "what happened", routed by attention and presence.

**Event journal:** `src/api/events/journal.ts` — append-only kv ring
(cap 2000, 14 days): `{ t, kind: 'receipt'|'order'|'arrival'|'departure'|
'camera'|'safety'|'device'|'routine'|'delivery'|'mode', member?, summary,
ref?, attention: tier }`. Writers: receipts ring (tap), presence, order
lifecycle, camera events (§12), proactive alerts, routines. This is the
single source for "what happened while I was gone".

**Router:** replaces ad-hoc notifyOwner. `route(event)` decides surface
per RECIPIENT: home → console card/speaker per tier; away → push (FCM) if
tier ≥ notify, else accumulate silently into the away digest; quiet hours
(per member) demote notify→digest except safety; dedupe window; WhatsApp/
Telegram as fallback channels when push unavailable. Config: Settings →
Users → member → Notifications (tier thresholds per channel).

**Touches:** new events module, proactive.ts emit points, push relay,
whisper/console delivery, Settings member panel.

**Done:** unit: routing matrix (home/away × tier × quiet hours); live:
departure creates journal entries, away member gets exactly one push for
a notify event and zero for ambient; journal endpoint `/v1/journal?since=`
paginates.

---

## Part II — Commerce features

### 5. Food: order-in

**Status: ✅ shipped (v26.11)** — sim api flow E2E; Uber Eats/DoorDash search-handoff connectors (menus can't be enumerated without partner APIs — honest intents + estimate carts)

**Flow:** "orb, lunch" → options calculus: leftovers (kitchen memory ⏳
inventory-lite: leftovers logged by cooking sessions + expiry heuristic),
reorder-usuals per service (order history), one new suggestion (rating
memory). Each option carries time + cost. Selection → §3 flow.
"The usual Thai" resolves from `order` history + member file.
**Services:** Uber Eats (handoff), DoorDash (handoff). Menu/deep-link
builders per service; reorder = re-fill last cart.
**Done:** sim + one real handoff order placed by a human tap; usual-reorder
resolves correctly per member; courier chime fires once; receipt correct.

### 6. Rides + the leave-by engine

**Status: ✅ shipped (v26.11)** — Uber/Lyft deep-link handoff (fare in app, $0 carts skip spend approval), leave-by engine live-verified (geocode + road-factor estimate + buffer, one nudge, TZ-correct); Uber API upgrade awaits developer approval (P-2)

**Leave-by:** calendar event with location + travel-time source (OSRM
self-hosted against OSM for privacy; Google Routes optional key) + prep
buffer → deck/push nudge at T-leave. Recompute on traffic delta ≥ 5 min.
**Ride tool:** op quote|book|status|cancel. Uber Rides API (real
API; requires app approval — blocker P-2) for quote+book+track; Lyft
price via handoff deep link for comparison. "Get me a ride back": phone
app sends current location (§13) → quote to home → §1 (rides tier) →
book → trip watch into journal + live widget.
**Done:** leave-by nudges verified against sim calendar; Uber sandbox
booking round-trips; ride-back from the app works with location; trip
events land in journal; autonomy laddering verified (3 approvals → offer).

### 7. Replenishment engine

**Status: ✅ shipped (v26.12)** — metered+cadence models, engine tick (auto under earned tier for api services, one cart-ready notify otherwise, no double-order), live-verified: PETG burned to threshold → 'Cart ready at Sim Store — $26.40' → confirm-paid → spend $26.40 in budgets. Printer-driven gram auto-report awaits the X2D

**Consumption models** (`src/api/commerce/replenish.ts`):
- **Metered:** filament — printer job reports grams (X2D API/HA sensor);
  spool weight set at load ("orb, new spool, 1kg"); threshold = next-job
  requirement + safety margin. Coffee/detergent — cadence models (events
  per week × per-event usage learned from restock intervals).
- **Declared:** "we're out of X" utterances → immediate list add + model
  bootstrap for that item.
- **Cycle-derived:** dishwasher/washer cycles via HA → detergent model.

**Engine loop (proactive lane, hourly):** for each tracked consumable:
projected-empty date < lead time ⇒ build cart at preferred store
(price-check across the item's known stores; same-day option when a hard
deadline exists e.g. queued print job) → §1 tier (consumables earn auto
under cap) → order or ask. **Batching:** carts to the same store within
72h merge; errands batch by TRIP (§10 pickup items attach to calendar
drives near the store's geofence).
**Done:** filament model verified against real print jobs (gram ledger
matches slicer estimates ±10%); a sim consumable auto-reorders under an
earned tier and asks over it; batching merges two carts; "we're out of"
bootstraps an item live.

### 8. Gifts & occasions

**Status: ✅ shipped (v26.14)** — occasions engine (T-10 nudge with spoiler guard, live-verified), deck topic, gift orders ride gifts-tier + spoiler guard (§3 tests), idea-mining via people/<name>.md dream convention, flowers fallback connector

**Occasions registry:** birthdays/anniversaries from family calendar +
per-person files (`people/<name>.md` — non-member people the household
talks about get files too; dream already extracts to them). Lead-time
planner: card at T-10d with concrete ideas.
**Suggestion mining:** dream-extracted facts about the person (hobbies,
complaints = needs, mentions) → agent proposes 2-3 concrete items with
prices (search via connector or WebSearch) + fallback (flowers day-of).
**Ordering:** always-ask tier, no exceptions, no earned path. Gift-wrap
option where the connector exposes it. Delivery watch with SPOILER
GUARD (recipient members never see gift orders in journal/deck — filter
by giftFor field).
**Day-of orchestration:** deck card with delivery states + contact-window
advice (their calendar if shared, else memory). Post-hoc: feedback noted
to the person's file.
**Done:** occasion fires T-10 in sim time; suggestions cite real memory
lines; spoiler guard verified with two member sessions; flowers fallback
books via handoff.

### 9. Reservations & bookings

**Status: ✅ shipped (v26.14)** — OpenTable/flowers zero-amount booking handoffs, calendar+leave-by pairing via tool guidance; affiliate API upgrade later

OpenTable/Resy handoff (affiliate API where granted). Flow: intent →
availability scrape/deep-link → always-ask → booked confirmation via §10
mail parse → calendar event + ride pairing offer (§6) + house handles
away-secure on departure. **Done:** sim + one real handoff reservation;
calendar + ride pairing fire; cancellation propagates.

### 10. The watch layer (mail parsing, tracking, returns, subscriptions)

**Status: ✅ shipped (v26.12)** — parser fixture suite (10 formats incl. allowlist rejection), mail-driven handoff close verified, subs registry + spend deck card; live sweep engages when a mail account connects; carrier polling + returns portal remain follow-ups

**Mail ingestion:** hub Gmail/Outlook read (exists) + parser pipeline
(`src/api/commerce/mailwatch.ts`): order confirmations (total, items,
service) → attach/create order records; tracking numbers → carrier
polling (UPS/USPS/FedEx public tracking endpoints); refund emails →
refundState; subscription renewal receipts → `subs:registry` with
amount + cadence + lastSeen.
**Returns:** "return this" → connector/portal deep link → label PDF →
IPP print (exists) → pickup schedule where carrier offers → refund watch
until posted → receipt closes.
**Subscription audit:** monthly deck card: renewals seen, per-sub
last-activity heuristic (mail/usage), cancel = handoff link + confirm.
**Privacy:** parser runs local, allowlist of sender domains, raw mail
never stored — only extracted fields; per-member mail stays per-member.
**Done:** parser fixture suite (20 real-format emails across services);
live: a tracking number polls to delivered and journals; label prints;
subs card lists a real renewal; privacy unit tests (non-allowlisted
senders untouched).

---

## Part III — On the Go (the phone is the away surface)

### 11. The away timeline — "what happened while I was gone?"

**Status: ✅ shipped (v26.10)** — /v1/journal(+catchup w/ last-seen), console arrival card, voice fast-path digest, agent chat digest; app timeline server-ready (client blocked on P-1)

**Source:** event journal (§4) filtered per member + attention ≥ glance,
grouped (deliveries, house, people, spending) with a generated 2-line
natural summary on top (local model, template-seeded).
**Surfaces:** app home screen when `presence=away` shows the timeline
since **their** last-seen; console shows it on arrival for 30s ("while
you were out"); voice: "catch me up" → spoken digest (fast-path template
+ agent for follow-ups). Widgets: lock-screen/home-screen away summary
(iOS WidgetKit + Android widget, counts + top line).
**Done:** leave → generate events (sim fleet + sim order) → app timeline
shows them grouped; arrival card appears once; "catch me up" speaks the
same facts; two members see different timelines.

### 12. Remote eyes — cameras with memory

**Status: ✅ shipped (v26.13)** — trigger→keyframe ring (7d, capped), journal events, /v1/camera/{events,frame}, agent camera_events op with vision Q&A over PAST frames (live-verified on the sim camera), per-member cameras toggle, watched watchers. Doorbell image push rides P-1

**Ingestion:** HA camera + doorbell integrations (Ring via HA) → motion/
person/doorbell events land in journal with a captured keyframe
(`camera:frame:<eventId>` kv, JPEG, 7-day retention, size-capped ring);
clips stay in HA/Ring — orb stores frames + pointers, never claims
retention it doesn't have.
**Q&A:** "what did you see at the front door at 3?" → event lookup →
frames → multimodal brain (askAboutImage exists) → answer with the frame
attached (console widget / app image). "Why is the light on in the
garage?" → camera op ask (exists) live frame.
**Live:** app camera tab = HA streams via existing ha-image/stream proxy
+ push-on-doorbell with frame attached (notification with image).
**Privacy:** per-member camera access toggle (app-groups gains `cameras`);
interior cameras default owner-only; every remote view is itself
journaled ("Ana viewed the porch camera 14:02" — watchers are watched).
**Done:** sim camera (HA demo/ffmpeg loop) events → journal + frames;
doorbell push arrives with image; Q&A answers about a past event frame;
access toggle blocks a member; view-audit entries appear.

### 13. Companion app v2 (iOS + Android parity)

**Status: ◐ server-ready** — every endpoint the app needs is live (journal/catchup, camera events+frames, orders, ride handoff links, approvals API); client legs blocked on P-1 (GitHub billing → CI builds + FCM config), then sideload

- **Push-first actions:** approval cards as actionable notifications
  (approve/deny from lock screen — FCM/APNs category actions → /v1/approvals);
  order status pushes with "Open checkout" for handoff payments; safety
  alerts full-screen.
- **Away home screen:** timeline (§11) + quick actions row: *Ride home*
  (one tap → §6 with app location), *Catch me up* (voice), *House check*
  (cameras §12 + sensors snapshot), *I'm heading back* (pre-arrival:
  climate to comfort, porch light at dusk, resume-home routine).
- **Location:** existing geofence + on-demand precise location for ride
  pickup (permission-gated, used transiently, never stored as history —
  only home/away state persists).
- **Siri/Assistant:** App Intents/Android shortcuts for the four quick
  actions ("Hey Siri, ask orb what happened").
- **Blocker dependency:** FCM needs google-services.json + the GitHub
  billing fix for Android CI (P-1).
**Done:** all four quick actions round-trip on both platforms; approval
from lock screen unlocks the sim lock flow; ride-home books from real
location (sandbox); pre-arrival routine fires from "heading back".

### 14. Remote voice polish

**Status: ✅ shipped (v26.14)** — fast-path coverage for the away verbs: 'catch me up' digest + 'house check' instant status; latency measurement on LTE awaits a remote device

Push-to-talk from the app over the remote URL (exists via voice WS);
target < 1.5s to first audio on LTE: pre-warmed WS on app foreground,
opus uplink (already), fast-path grammar coverage for the away verbs
(ride, catch-up, house check). **Done:** measured cold/warm latency on
LTE logged; fast-path hits for the four away intents.

---

## Part IV — Blockers & risk pass (do these answers first)

- **P-1 Push infra:** Android CI blocked on GitHub billing; FCM needs
  google-services.json. Without push, §11/13 degrade to poll-on-open —
  acceptable interim, ship anyway. *Action: Martin fixes billing;
  fallback: app polls journal on foreground.*
- **P-2 Uber API access** requires developer application + approval;
  sandbox first. Fallback ladder: deep-link handoff (`uber://` with
  pickup/dest prefilled) is shippable WITHOUT approval — build handoff
  first, upgrade to API silently later. Same pattern for every service:
  **handoff is always the floor**; ToS-sensitive automation (headless
  checkout) is explicitly out — a human always taps Pay in handoff mode.
- **P-3 Amazon** has no consumer purchase API; cart deep-links + mail
  watch only. Price data via scrape is ToS-fragile → use search results
  the human can see; never claim a price we can't cite.
- **P-4 Instacart** dev platform is waitlisted → handoff until granted.
- **P-5 Payment safety:** orb NEVER stores PANs (wallet stays metadata);
  handoff keeps payment at the merchant; api-mechanism services charge
  the card on file at that service. Budgets are pre-authorization only.
- **P-6 Mail parsing privacy:** local-only, sender allowlist, extracted
  fields only, per-member isolation; parser must be dream-independent
  (no raw mail in episodes).
- **P-7 Travel-time source:** self-hosted OSRM (privacy default, no key)
  with optional Google Routes key for traffic realism; leave-by works
  degraded (static + buffer) with neither.
- **P-8 Ring/camera:** via HA integration only (no direct Ring API
  dependency); frames capped (7d/200MB ring) so the Spark disk is safe.
- **P-9 Spoiler guard** is a correctness requirement of §8 — test it
  like security (member session must never see giftFor≠them orders).
- **P-10 Relay growth:** new OAuth providers (Uber) added to orb2.app
  env + PROVIDERS; refresh endpoint already generic.
- **P-11 Sim-commerce harness (Part V) BEFORE real connectors** — the sim
  fleet lesson: paths tested before hardware/services arrive.

---

## §15 — Standing intents: the agent's own lanes ✅

**The gap it closes.** Every proactive lane above (leave-by, replenish,
mail-watch, occasions…) is code WE wrote. §15 makes the loop
self-extending: the agent can hold an intention over days or weeks —
"watch the price of Martin's usual milk, speak up under $4" — and work
on it between conversations, without a purpose-built checker per case.

**Model.** An Intent is `{goal, member, cadence_min, next_at, state,
status, origin chat|dream, expires_at}` in kv `intents:all`
(`src/api/intents/engine.ts`). The tick chain gains `tickIntents`: due
intents (max 2/tick, serialized, 4-min wall-clock cap each) each get a
**headless agent turn** through `runChannelTurn` — the full chat runtime
(native tools, memory recall, consent gradient, receipts, episodes) with
a worker charter instead of a user message (`intents/turn.ts`). Runs are
STATELESS: continuity lives in the intent's `state` scratchpad (baseline
price, seen-set, dates), so per-run cost is bounded forever. The worker
files its result via Watch op:'report' (kv mailbox) → `quiet` updates
state; `notify`/`done` route through the journal's attention rules
(quiet hours, away push); a run that never reports is treated as quiet.

**Registration — three doors.** (1) Conversation: the system prompt
forbids promising monitoring without registering (Watch op:'add'); "tell
me when X" becomes an intent in the same turn. (2) Dream: consolidation
step 4 may register AT MOST ONE watch per night from an observed habit
(usual product + typical price), announced with an ambient journal note
— no silent watchers, ever. (3) Never by code: no hardcoded watch types.

**Trust.** Watches are visible and controllable in Settings → Users →
"Standing watches" (`/v1/intents` GET/PATCH/DELETE; pause/resume/drop;
members see theirs, owners all). Worker turns cannot place orders or
take gated actions — an unattended approval resolves "not approved" and
the worker escalates a recommendation instead; anything it wants bought
goes through §2 budgets like every other hand.

**Bounds.** ≤20 active per household; cadence floor 30 min (default
daily); default expiry 60 days (ambient nudge on expiry, renewable);
finished intents kept 30 days for the Settings list.

**Done when:** unit suite (engine.test.ts: schedule/report/expiry/pause/
cap); live: "watch X, tell me if under $N" registers + first run files a
baseline report; forced run with a met condition lands a notify in the
journal/deck; dream registers ≤1 habit watch with its announcement;
Settings lists/pauses/drops. ✅ shipped v26.19.

---

## §16 — The audio stack: hear well, everywhere ◐

**Shipped (v26.20–21):** STT on the GPU it never used — CTranslate2 has
no CUDA on aarch64, so faster-whisper always ran CPU on the Spark; the
`hf-whisper` engine runs **whisper-large-v3-turbo** via transformers on
torch-CUDA (6s utterance → 0.24s, exact). Ring satellite hears: MQTT
camera discovery, own go2rtc, speechnorm gain (Ring mic ≈ −40 dB at
distance), **grammar-constrained Vosk** wake ("orb" decodes as "or" in
open vocab; grammar verified to −40 dB, zero false triggers), replies
via the room's Sonos (`/v1/ring/speak` → bridgeAnnounce).

**Planned, in order of payoff:**
1. **Custom wake model** — train "hey orb" with openWakeWord (positives
   generated with our own TTS across voices/rates/noise); one server-side
   spotter serves EVERY satellite (Ring, future ESP32 pucks via
   microWakeWord export). Vosk-grammar stays as the fallback.
2. **Self-echo guard** — the satellite must not wake on orb's own reply
   coming out of the Sonos: suppress wake-spotting during playback
   windows (+2s tail), and long-term subtract the known TTS reference.
3. **Parakeet TDT engine** — `ORB2_STT_ENGINE=parakeet` (NeMo): NVIDIA's
   streaming RNN-T, first-class on this hardware, benched against
   hf-whisper on real household audio before switching defaults.
4. **Ring two-way audio** — our go2rtc's native `ring:` source with its
   OWN refresh token (Settings → Ring card gains "enable speaker": a
   second token mint through orb2-api's Ring OAuth flow; NEVER share
   ring-mqtt's token — rotation races invalidate it). Sonos fallback
   remains for rooms with better speakers than the camera's.
5. **TTS**: Kokoro stays the realtime voice. Optional persona voice via
   Chatterbox (MIT) for non-realtime narration — briefings, the diary —
   where its quality beats latency concerns. SenseVoice paralinguistics
   (vocal tone → `vocalContext`) revisits once accuracy is tuned
   (env-gated today).

**Done when:** wake false-accept < 1/day and false-reject < 1/10 at
3 m in kitchen noise (logged over a real week); echo guard: zero
self-wakes during a 50-reply soak; STT bench published in docs (WER +
latency, whisper vs parakeet, on-box); two-way: "hey orb" → answer from
the RING speaker with Sonos fallback intact.

---

## §17 — The hybrid brain: sovereign by default, frontier on demand ◐ (core ✅ v26.24)

**Doctrine.** The harness is the product; the model is a component.
Voice, home control, cameras, money, presence: **local, always** — the
household's intimate data never leaves the box as a side effect. But the
local model is the weakest link for deep reasoning, and `modelRouter`
already routes hard turns (coding/reasoning/length heuristics) to a
stronger model when enabled. §17 makes that a first-class, governed
capability instead of a heuristic.

1. **Route classes, not regexes.** Explicit classes with per-class
   Settings toggles (owner): `planning` (specs, multi-step designs),
   `dream` (nightly consolidation), `watch-research` (§15 worker turns
   flagged research-heavy), `deep-chat` (user says "think hard").
   Voice and anything device/money-touching stay local, non-negotiable.
2. **The privacy firewall.** Outbound context is allow-listed per class,
   scrubbed by construction: no camera frames, no journal dumps, no
   member locations, no ledger, no memory files wholesale — the turn
   carries only the task and the minimum context the class permits. A
   Settings card ("What leaves the box") states each class's policy in
   plain language.
3. **Visible and metered.** Every cloud turn journals an ambient
   `cloud` event (class, tokens, cost) and rides the §1 money rails:
   monthly cloud-reasoning budget with the same ask/earned/never tiers
   and receipts as any other spend. Cloud unreachable → silent fallback
   to local; the orb is never dumber than its own hardware.
4. **Engine.** Anthropic SDK (Claude) as the first provider; the
   provider override plumbing already exists (`providerOverride`), so
   this is routing + firewall + metering, not a rework.

**Shipped v26.24:** route classes + per-class/master toggles (all OFF by
default except deep-chat, and nothing routes without the master + a key);
firewall-by-construction at both turn-assembly sites (non-dream cloud
turns carry no household context; images/voice never route); metering →
ambient journal receipts + monthly cap (over cap → local); Settings
"What leaves the box" card; Anthropic-direct or OpenRouter provider.
Remaining for ✅: the outbound payload-grep soak below.

**Done when:** each class togglable and OFF by default except
`deep-chat`; firewall proven by a test that greps outbound payloads for
forbidden material (frames/locations/ledger) across a scripted week;
cloud budget enforced + receipted; kill-switch (one toggle → 100% local)
verified live.

---

## §18 — The digital twin: a house the orb can point at ◐ (core ✅ v26.24)

**Why.** The orb knows *entities*; it should know *places*. "Where did I
leave my phone", "turn off everything upstairs", "answer through the
speaker nearest the kitchen", camera→room association, and §11's leave-by
all want one thing: a spatial model of the home.

1. **The plan.** `twin:plan` (kv): floors → rooms (simple polygons on a
   grid canvas) → placements: every device/entity pinned to a room and
   optional x,y (Ring cam, speakers, TV, printer, sensors, matter
   devices). Seeded automatically from HA areas (area ≈ room) so day one
   isn't blank; refined in a Settings floor-plan editor (drag rooms,
   drop devices). A `house-map` widget renders it live: device states in
   place, presence dots, camera-event badges — the deck's home view.
2. **Twin-aware behavior.** Nearest-output selection (the §16 Ring
   fallback speaker becomes twin-driven, not an env var); `associateCamera`
   uses geometry instead of name heuristics; "everything upstairs / in
   the office" resolves through the plan; energy and routines group by
   room; journal events carry room context ("motion — living room" from
   geometry, not entity naming).
3. **Presence, two tiers, consent-shaped:**
   - **Inside** (no app required): room-level presence inferred from
     twin-anchored signals — motion/occupancy, camera person events,
     which satellite heard the wake word, whose phone is on Wi-Fi
     (home/away only). Stored as `presence:<member>` {room, confidence,
     last_seen}; decays to "home, somewhere" honestly rather than
     guessing.
   - **Outside**: ONLY with the phone app installed AND that member's
     explicit location-share opt-in — per-member toggle, OFF by default,
     revocable anytime in app/Settings, and the OWNER CANNOT ENABLE IT
     for someone else: consent belongs to the member. Coarse location
     (geohash + timestamp) powers leave-by, arrival cards, "get me a
     ride back" — never continuous tracking, never stored beyond the
     journal's ring.
   - **Watched watchers, symmetric:** any "where is <member>" asked by
     someone else is itself journaled and visible to the asked-about
     member; per-viewer visibility grants (a member chooses who may see
     their presence) with gift-spoiler-grade enforcement. Presence never
     leaves the box (§17 firewall forbids it categorically).

**Shipped v26.24:** plan model + HA-area seeding (keeps owner edits;
places bridge speakers by name), Settings "House plan" card (floors,
reseed, self-only location-share toggle), `house-map` widget (#52) +
Home op 'house' (auto-seeds on first use), nearest-speaker replies via
twin geometry in /v1/ring/speak, motion→room inside-presence signals
(20-min honest fade) surfaced in Home op 'presence', consent hard-block
live-verified (owner enabling another member's sharing → refused),
watched-watchers journaling on cross-member queries, /v1/twin API incl.
the app's future /v1/twin/location contract. Remaining: polygon editor,
geometric "everything upstairs" control, wake-word member attribution,
and the outside tier's real data source (the phone app, P-1).

**Done when:** plan editor round-trips (seed from HA areas → edit →
persist → widget renders); "turn off everything upstairs" resolves by
geometry in the sim fleet; nearest-speaker answer verified from two
rooms; inside-presence shows the right room in a scripted walkthrough
(sim motion sequence); outside tier hard-blocked without app+opt-in
(test: owner toggling another member fails); every cross-member
presence query journaled.

---

## Part V — Testing: the sim-commerce harness (Part V)

`src/api/commerce/sim.ts` — a full ServiceConnector (`sim-store`,
`sim-rides`, `sim-eats`) with deterministic menus/prices/ETAs, a fake
mail generator (confirmation/tracking/refund fixtures for §10), and a
clock-driven courier/trip simulator. Playwright suites: order-in flow
(options→approve→checkout→delivered chime), ride-back (location→quote→
book→trip→journal), replenishment (consume→threshold→auto under cap),
gift (occasion→suggest→ask→spoiler guard), away timeline (leave→events→
app view→arrival card). Every § above cites this harness in its Done.

---

## Part VI — Build order (dependency-sorted, release-mapped)

Stages ship in order, one calendar release (`v26.N`) each:

1. **Stage 1 — foundations:** §1 budgets/spend policy + §4 event journal
   (both pure-local, fully testable now) + sim-harness skeleton (Part V).
2. **Stage 2 — commerce core:** §2 connector framework + §3 order
   lifecycle + order widget; sim connectors green end-to-end.
3. **Stage 3 — away surface:** §11 away timeline + §4 router + app
   timeline (poll mode if P-1 unfixed); "catch me up".
4. **Stage 4 — food & rides:** §5 handoff (Uber Eats/DoorDash) + §6
   rides handoff + leave-by (OSRM); §13 quick actions wired to them.
5. **Stage 5 — the closed loop:** §10 mail watch (parsers, tracking,
   subs card); §7 replenishment (filament first — the printer is real,
   the model verifiable).
6. **Stage 6 — remote eyes:** §12 (HA camera events, frames, Q&A, push).
7. **Stage 7 — full hands:** §8 gifts & occasions + §9 reservations +
   §6 Uber API upgrade (if approved) + §14 voice polish + the playbook
   walkthrough as the release test: one scripted week in sim time,
   every diary beat asserted.
8. **Stage 8 — ears (§16):** custom wake model + self-echo guard first
   (they compound every voice interaction), then the Parakeet bench and
   Ring two-way audio.
9. **Stage 9 — the twin (§18):** plan model + HA-area seeding + editor +
   house-map widget, then twin-aware behaviors, then inside presence;
   the outside tier lands only WITH the phone app (Part III / P-1).
10. **Stage 10 — hybrid brain (§17):** route classes + privacy firewall
    + metering. Deliberately last: it upgrades every earlier stage's
    reasoning once the data-boundary rules it must respect (§18
    presence, §12 frames, §1 ledger) all exist to be enforced.

Each release: version bump, tag, docs, gallery/smoke green, and the
relevant playbook ⏳ markers flipped.

---

*v0.2 taught the orb restraint. v0.3 gives it hands — and a leash made of
budgets, receipts, and honesty about what it can and cannot undo.*
