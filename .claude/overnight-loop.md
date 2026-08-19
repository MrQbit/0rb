# Overnight loop state (2026-08-19 night)

Directive: alternate loops until 3 consecutive clean checks EACH.
Commit locally, DO NOT push. One change at a time, tested, deployed.

## Loop A — feature research (house-AI gaps → build with widgets)
Clean checks: 0/3
Done:
- A1 morning briefing (buildBriefing + Today widget + ORB2_BRIEFING_TIME) e20deef
- A2 staple auto-reorder (every_days recurrence + revive sweep + nudge + ↻ badge) dfd9775
- A3 house modes home/away/vacation/guest (mode-aware watcher, motion alerts when away, secure:true lock-up macro) 9f94824
- A4 care routines (recurring HH:MM reminders w/ weekday filter, per-member delivery — meds/pets/plants) 83f67db
Ideas queue: auto grocery reorder (recurring shopping items), smart
scheduling suggestions (learn routines → propose automations), energy
insights, arrival/leave routines (welcome-home scene, away mode),
medication reminders, package tracking, meal planning, sleep sounds,
guest mode, vacation mode, plant care, pet feeding, laundry timer flow.

## Loop B — UI scrutiny (details: every widget/button/icon/motion)
Clean checks: 0/3
Done:
- B1 SVG close buttons + resize grip cue b400e78
- B2 stacking toasts (no more lost messages) dfd9775
- B3 focus-visible language everywhere + shared widget scrollbars 9f94824
- B4 media remote emoji → stroked SVGs, flex-centered buttons 83f67db
Hunt list: toasts styling/stacking, widget spawn overlap edge cases, pill
telemetry truthfulness, focus rings everywhere interactive, scrollbar
styling consistency across widgets, orb mic/camera button states, login
page polish, empty states for docker/model widgets, calendar widget nav,
media widget artwork fallback aesthetics, keyboard nav for panel tabs,
reduced-motion audit, contrast audit (ink-dim on glass), settings brain
card layout, publish flow UX.
