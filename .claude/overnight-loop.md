# Overnight loop state (2026-08-19 night)

Directive: alternate loops until 3 consecutive clean checks EACH.
Commit locally, DO NOT push. One change at a time, tested, deployed.

## Loop A — feature research (house-AI gaps → build with widgets)
Clean checks: 3/3 — LOOP A COMPLETE (pass-7 clean)
Done:
- A1 morning briefing (buildBriefing + Today widget + ORB2_BRIEFING_TIME) e20deef
- A2 staple auto-reorder (every_days recurrence + revive sweep + nudge + ↻ badge) dfd9775
- A3 house modes home/away/vacation/guest (mode-aware watcher, motion alerts when away, secure:true lock-up macro) 9f94824
- A4 care routines (recurring HH:MM reminders w/ weekday filter, per-member delivery — meds/pets/plants) 83f67db
- A5 usage-pattern automation suggestions (haPatternDigest 7d history → suggest op, confirm-before-create) c502edb
- A6 arrival routines (auto-disarm on member arrival + per-member arrival_scene pref) 62c01a9
- A8 instant safety-class alerts (smoke/CO/gas/leak — every mode, self-clearing)
- A9 device-health watch (battery ≤15%, unavailable >24h, weekly renudge cap)
- A10 house-mode widget (4 posture chips + /v1/home/mode)
- A11 announce 'where' room/speaker targeting
- A12 yearly recurring events (birthdays) + calendar storage-integrity fix
- (owner-directed) smart-paste connector setup 36761f7
Ideas queue: auto grocery reorder (recurring shopping items), smart
scheduling suggestions (learn routines → propose automations), energy
insights, arrival/leave routines (welcome-home scene, away mode),
medication reminders, package tracking, meal planning, sleep sounds,
guest mode, vacation mode, plant care, pet feeding, laundry timer flow.

## Loop B — UI scrutiny (details: every widget/button/icon/motion)
Clean checks: 0/3 (pass-7 found: B15 panel brand + chevron)
Done:
- B1 SVG close buttons + resize grip cue b400e78
- B2 stacking toasts (no more lost messages) dfd9775
- B3 focus-visible language everywhere + shared widget scrollbars 9f94824
- B4 media remote emoji → stroked SVGs, flex-centered buttons 83f67db
- B5 calendar month navigation (SVG chevrons, title=jump to today) c502edb
- B6 docker/model widget empty + error states 62c01a9
- B7 console-wide reduced-motion support
- B8 login code digits-only + auto-verify at 6
- B9 widget title tooltips + slider aria-labels
- B10 users panel role badges + guarded role toggle
- B11 timers widget cancel buttons + DELETE /v1/home/timers/<id>
- B12 settings-panel-wide focus rings
- B13 shopping remove button → SVG (last text-glyph button)
- B14 truthful pill telemetry (live timer counts, climate/media/printer/mode lines)
- B15 chat panel '0rb' branding + collapse chevron SVG
Hunt list: toasts styling/stacking, widget spawn overlap edge cases, pill
telemetry truthfulness, focus rings everywhere interactive, scrollbar
styling consistency across widgets, orb mic/camera button states, login
page polish, empty states for docker/model widgets, calendar widget nav,
media widget artwork fallback aesthetics, keyboard nav for panel tabs,
reduced-motion audit, contrast audit (ink-dim on glass), settings brain
card layout, publish flow UX.

## Interruption (owner returned, ~01:50)
Owner queued: site overhaul (pushed to MrQbit/orb — allowed: site ships via
push) + connectors smart-paste QoL (committed locally 36761f7 + whitelist
fix). Loop resumes on next wakeup at clean-check verification pass 2.
