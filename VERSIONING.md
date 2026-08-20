# Versioning

0rb uses **Apple-style calendar versioning**, semver-shaped:

```
v<YY>.<RELEASE>[.<PATCH>]      e.g. v26.1, v26.2, v26.2.1
```

- **YY** — the calendar year of the release (26 = 2026). Rolls over each
  January to `v<YY+1>.0` (first real release of the year is `.1`).
- **RELEASE** — increments on **every PR / merged change batch** within the
  year. No exceptions: if it lands on `main`, the release number moved.
- **PATCH** — hotfixes only (a fix to an already-tagged release).

Mechanics:
- `package.json` `version` is the single source of truth (`26.1.0` ⇢
  displayed as `v26.1`). The build inlines it (`MACRO.DISPLAY_VERSION`)
  and `/v1/info` reports it.
- Every release batch: bump `version`, commit, tag `v26.N`, push with
  `--follow-tags`.
- CI (`.github/workflows/version-bump.yml`) fails any PR that does not
  increase the version over the base branch.

History note: versions below 26 (`0.1.x`) predate this scheme — v26.1
(2026-08-20) is the first calendar release.
