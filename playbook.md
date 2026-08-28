# The 0rb Playbook

**Life with a fully evolved orb — a walkthrough, written as a diary.**

The baselines are the right ones: **S.A.R.A.H.** — the house in Eureka that
runs itself, knows its people, and has opinions — and **JARVIS** — the
partner that anticipates, builds alongside you, and never needs the same
instruction twice. 0rb's version of that is quieter and yours: it runs on a
box in your closet, everything it knows lives in files you can read, every
action leaves a receipt you can undo, and it asks before it matters.

This playbook shows what that looks like: **Day 0** (the orb arrives),
**Day 1** (it learns the house), then a settled week — a workday, a maker
weekend, a music evening, a romantic dinner — and finally the invisible
machinery that makes it work: the continuous loop, the feedback loop, the
memory system, and how the orb improves itself.

Capabilities marked ⏳ are the near-horizon; everything else ships today.

---

## Day 0 — The orb arrives

**18:40.** The box comes home. Power, ethernet, done — there is no app to
download first, no account to create. From a phone on the house Wi-Fi:
**orb.local**.

The screen shows a slowly breathing green orb and a QR code. That code is
the whole security model of first contact: *the orb belongs to whoever is
standing in front of it.* Scan, and you're the owner. Nobody on the
internet can do this; nobody who isn't in your home ever sees the code.

**18:43.** The orb speaks for the first time:

> "Hello. I'm your orb. What would you like to call me?"

You keep "Orb." It asks who lives here — you add Ana by invitation link
(she taps it on her phone, types her name, gets her sign-in code; that's
her entire enrollment). Then:

> "Here's what I can already see on your network. Nothing is connected
> until you say so."

It lists the Sonos in the living room, the LG TV, the Brother printer,
your MacBook. You say "sounds good." Speakers and printer work **that
instant** — AirPlay and IPP need no pairing, no drivers, no Home
Assistant. The orb's rule: *direct first, hubs only for what direct can't
do.*

**18:50.** Settings → Apps → **Your accounts**. One tap each: Spotify
(sign in — done; like linking a TV), Google (one consent lights up Gmail,
Calendar, and Drive together). The orb never sees your passwords; a relay
holds the app registrations, your tokens stay sealed on your box, keyed to
you — not to the household.

**18:55.** Settings → Home shows a Matter pairing code. In Apple Home: Add
Accessory → enter code. Now **Siri controls the orb's world** from every
Apple device — and the orb shows up in Home as its lights, its lock, an
"Away Mode" switch, and one occupancy sensor per family member.

**19:00.** Total setup time: twenty minutes, most of it spent choosing a
name. The orb's first receipt is already in the ledger: it turned on the
hallway light when you asked it to, and noted how to turn it back.

---

## Day 1 — It learns the house

The first days are an apprenticeship. The orb is deliberately humble: it
asks a lot, remembers everything it's told, and shows its work.

- You say *"we're leaving"* — it asks: away mode locks the door and kills
  the lights; approve? You approve. A receipt appears: what it did, and an
  **Undo** that actually reverses it.
- The third time you approve the same thing, it offers: *"Want me to just
  do this from now on?"* — **earned autonomy**, always visible in your
  profile, revocable in one tap.
- You mention your coffee order once, in passing. It lands in your personal
  memory file — a markdown file you can open, edit, or delete. Ask it
  tomorrow: *"flat white, always."*
- Ana tells it she goes by "Ani." From then on it calls her Ani — because
  **she** asked. It will never adopt a nickname it merely overheard.

By the end of the week the approval cards are rare: the orb has learned
which of your instructions are policy and which are moods.

---

## A Tuesday — the workday

**06:20.** The orb has been awake all night, but quietly: the continuous
loop ticked once a minute — presence, device health, safety sensors, mode
logic — and found nothing worth waking anyone for. That silence is a
feature. SARAH never narrated the plumbing; neither does 0rb.

**06:58 — sunrise.** You pad into the kitchen and say "morning." The
**deck** appears — assembled *at that moment*, not overnight, because 3am
weather is stale by breakfast:

- **Weather** at home: 74° climbing to 97, sun all day.
- **Headlines** — six, from your searx, no ad networks involved.
- **Unread mail** — the two that matter, out of nineteen.
- **Today** — the 10:00 design review, Ana's dentist at 15:30, piano
  tuner Friday (it will remind you Thursday night).
- **Worth a look** — "Front door sensor battery, 12%."

You thumb-down the headlines card (a slow news week); the deck learns.
Ana's deck, an hour later, is different — her mail, her calendar, her
topics. Same orb, two mornings.

**07:15 — cooking (breakfast edition).** "Orb, ideas for the eggs and the
leftover sweet potato." It knows your kitchen because you've told it over
weeks — the cast iron, the immersion blender, the fact that Ana won't eat
cilantro (that's in *her* file; it checks both). It proposes a hash,
narrates the timing while your hands are full, and sets the timer without
being asked twice. The timer lives as a widget on the console and counts
down on the deck. When you say "add smoked paprika to the list," it's on
the shopping list with the staples — and Thursday, when the list is long
enough, it will ask whether to prep the grocery order for checkout.
*It never claims to have purchased anything itself.*

**09:00 — work: software development.** You're deep in a client repo. The
orb is your rubber duck with tools: it renders the failing test matrix as
a chart widget, pulls the doc page you half-remember, keeps a running
`decisions.md` in its memory of the architecture calls you make out loud.
When you say *"remind me why we picked SQLite over Postgres here,"* the
answer comes from **auto-recall** — the reasoning you dictated three weeks
ago, resurfaced because the question matched it semantically. You never
told it to remember; the nightly dream extracted it from the conversation.

**10:00.** During the design review, your phone is in the other room. The
orb takes a family note from Ana — "tell him the dentist moved to 4pm" —
and holds it for the moment you next speak to it, then updates the
calendar and the deck. Two receipts.

**12:30 — a small proactive save.** The loop notices the office window
sensor open + rain in the hourly forecast (⏳ weather-conditioned rules
are the next routines milestone; today it flags it in the deck's "worth a
look" instead). You get one quiet card, not a siren.

**15:20.** "Orb, I'm picking up Ana — house to away, and secure it."
Locks click, lights die, alerts arm. No approval card anymore — this is
one of the things it has *earned*. The receipt notes the prior state; the
whole thing is one Undo away.

**18:00 — arrival.** Presence sees Ana's phone hit the geofence; the house
flips home, hallway light on because it's after dusk, and the orb delivers
the note that was waiting for her arrival, on the kitchen Sonos, only
because she's the one who walked in.

---

## A Saturday — the maker day

**08:30 — 3D printing.** The X2D has a queue: two robot chassis brackets
and a guitar wall hook. "Orb, start the brackets, standard PETG profile."
The printer widget shows the live camera, layer, and temps; the loop
watches it so you don't have to. At layer 40 the first-layer camera check
looks wrong (⏳ camera-ask automation; today you ask — *"orb, does the
print look okay?"* — and its vision model looks at the frame and answers).
Two hours later, one chime: "brackets done, bed cooling."

**10:00 — electronics.** Workbench mode: the orb pulls the ESP32 pinout
onto the big screen, keeps the running parts list ("we're out of 10k
resistors" goes straight to shopping), and logs the calibration constants
you read out loud — which land in `projects/robot-arm.md` in its memory,
dated, superseding last month's numbers instead of overwriting them. Ask
it in December "what were the August PID values?" and it will know both.

**11:30 — robots.** The arm's firmware builds on the Spark ("orb, flash
rev 12 to the arm" — a routine that compiles, flashes over the network,
and reports). When the elbow servo stutters, you describe it; the orb
recalls that the same symptom in June was a brownout, checks the bench
supply reading through the smart plug's power meter, and it's right
again. That's JARVIS behavior in the small: *the memory of every previous
debugging session, on tap.*

**16:00 — guitar.** "Orb, practice mode." The living room shifts: lights
warm, deck silent, a metronome widget at 92 bpm because that's where you
left the sweep-picking exercise Wednesday (its practice log remembers).
It plays the isolated backing track on the Sonos; you say "again, slower"
and it drops 8 bpm. Twenty minutes later: "that's the longest streak this
month" — the feedback loop applied to *you*, gently.

**17:00 — piano.** Ana's turn; the orb switches profiles the moment her
voice takes over. Her lesson pieces, her tempo history, her teacher's
Thursday note — none of it visible to your practice log, all of it in
hers.

---

## A Friday evening — the romantic dinner

**You, at lunch:** "Orb — dinner for two tonight. The good one."

By the time you're both home:

- The **menu** is proposed from what's actually in the kitchen inventory
  plus one shopping run it suggested at 15:00 (approved from your phone) —
  saffron risotto, because it remembers the trattoria story from your
  anniversary note *and* that Ana had it starred in a recipe you shared.
- **17:45** it starts you on the mise en place, pacing the steps so the
  risotto's last ladle lands as Ana's train does. Timers chain; its voice
  stays in the kitchen speaker only.
- **19:05** — presence: Ana's home. The living room drops to 30% warm
  light, the dining scene fades in, and the *Quiet Dinner* playlist starts
  on the Sonos at 25% — hers and yours merged, minus everything either of
  you has ever skipped on a Friday night.
- The orb then does the most important thing: **it disappears.** House
  mode "guest-quiet": no cards, no chimes, door nagging muted. The only
  thing it will interrupt for tonight is smoke, water, or the front door.
- **22:30**, kitchen lights back to full for cleanup without being asked —
  it noticed the dishwasher door open. One receipt for the whole evening,
  collapsed: *"Ran 'romantic dinner' — 14 actions, all reversible."*

---

## The invisible machinery

### The continuous loop
Once a minute, forever: presence, device health, safety sensors, printer
state, routine schedules, mode logic, deck readiness. It is intentionally
boring — 99% of ticks change nothing and say nothing. The loop's product
is *timing*: the right card at the right moment, and silence otherwise.

### The feedback loop
Everything you do teaches it: deck thumbs reorder topics and eventually
drop them; approvals graduate into autonomy; corrections land in memory as
dated, superseding facts; skipped songs shape playlists; the receipts you
undo teach it what it got wrong. None of this is a black box — the deck
shows its topic scores, your profile shows its earned permissions, and
memory is markdown you can read.

### Memory (v2 — how it knows you)
Four layers, all inspectable:
1. **Files** — MEMORY.md + topic files (household), `members/<you>.md`
   (personal). Human-readable, human-editable, human-deletable.
2. **Episodes** — a rolling log of the last days' real conversations.
3. **The dream** — every six hours, the orb re-reads recent episodes and
   *extracts* what deserves to be durable: preferences, routines, people,
   project facts. New facts get dated; contradictions are superseded, not
   erased ("espresso (until 2026-06); now flat white").
4. **Auto-recall** — every message you send is semantically matched
   against everything it knows, and the relevant memories ride into the
   turn silently. You never say "remember when" — it already did. The
   memories it uses most rank up (salience); "forget everything about me"
   in your profile is one tap and means it.

### Self-improvement
Two speeds. **Daily:** the feedback loop above — no code changes, just a
system that fits you better each week. **Structural:** the orb can edit
its own source, build it, validate the result in a sandbox, and promote it
with automatic rollback (owner-gated, receipted). When a new stack version
ships, it is one `git pull` away, and your `.orbbackup` — memory, members,
settings, receipts, even the Matter fabric so Apple Home never notices —
means the orb's *self* survives any rebuild or new hardware.

### Trust, restated
The reason any of this is livable: **read** actions just happen;
**reversible** actions happen and leave an inverse; **consequential**
actions ask first; a hard core (unlocking doors for strangers, spending
money) is *never* autonomous, no matter how much trust it has earned. The
ledger is always one tap away, and Undo is real.

---

## The one-page daily rhythm

| When | What the orb does | Loop |
|---|---|---|
| Sunrise | Fresh deck on first contact — weather, mail, calendar, house | continuous |
| Morning | Cooking assist, timers, list capture, commute/weather nudges | reactive |
| Workday | Research, widgets, decisions logged, notes held for arrival | reactive + memory |
| All day | Presence → modes; safety watch; printer/robot/device health | continuous |
| Evening | Scenes, music, practice modes, guest-quiet when it matters | reactive + learned |
| Night | Dream: extract facts from the day, tidy memory, reindex | feedback |
| Weekly | Routines fire; deck topics resettle; autonomy review in Settings | feedback |
| Always | Every action classified → approved when needed → receipted → undoable | trust |

---

*S.A.R.A.H. ran the house. JARVIS built the suit alongside the man. 0rb's
ambition is both, scaled to a real home: a life operating system whose
memory you can read, whose actions you can undo, and whose loyalty is
structural — it runs on your hardware, answers to your household, and gets
better at being yours every single day.*
