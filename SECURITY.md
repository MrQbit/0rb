# Security

0rb is a **single-user, allowlisted** system designed to run on hardware you
own. This page describes its security posture, then how to report
vulnerabilities.

## Authentication and sessions

- **No passwords.** Sign-in is a one-time code sent to an **allowlisted**
  email (or Telegram account). The first allowlisted email becomes the owner.
  Unknown emails get the same response as known ones, so the allowlist can't
  be probed.
- **Sessions are stateless HMAC tokens** signed with `ORB2_AUTH_SECRET`,
  carried as an HttpOnly cookie (browser) or a Bearer token (iOS/channels).
  The API routes, the console shell (gated server-side), and the voice
  WebSocket all require a valid session. Codes are stored hashed, expire in
  10 minutes, and have resend cooldowns and attempt limits.

## OTP delivery and the hosted relay

Email codes are delivered by the first available of:

1. **Your own SMTP** (`ORB2_SMTP_*`) — fully self-hosted, nothing leaves your
   infrastructure.
2. **The hosted relay** (`https://orb2.app/api/otp-send`, Resend behind it) —
   so a fresh install has working sign-in with zero configuration. The relay
   accepts only a recipient and a code, can only send the one fixed OTP
   template, and is rate-limited. **Opt out** with `ORB2_OTP_RELAY_URL=""`
   (codes then appear in the API log instead).
3. **The API log** — the code is logged locally for the operator to read.

Telegram OTP delivery is also supported and stays entirely between your box
and Telegram's Bot API.

## Wallet: metadata only

The Wallet stores payment-method **metadata only** — a label, brand, and
last4. There is a hard server-side guard: anything longer than exactly four
digits is refused, so a full card number can never land in the store, even by
accident. 0rb never holds card numbers, tokens, or credentials; actual
payment always happens in the user's own wallet sheet (Apple/Google Pay) or on
the merchant's site. Likewise the Shopping flow only ever hands off to a
merchant checkout — the agent is instructed to never claim an order was
placed.

## Widget URL validation and sandboxing

- Every URL a widget spec supplies passes through a validator before it can
  reach an `iframe`, `<img>`, or `window.open`: only `http(s)` URLs and the
  agent's own `/v1/workspace/` and `/pub/` paths are allowed — `javascript:`,
  `data:`, and empty/relative URLs are dropped.
- Embeds are `iframe`-sandboxed, and only an allowlist of known hosts renders
  inline; anything else degrades to an explicit "open in new tab" link with
  `rel=noopener`.
- Map widgets are validated **server-side**: model-invented coordinates
  (the "Null Island" [0,0] pattern) are rejected and place strings are
  geocoded on the server, so the map can't be steered by fabricated data.
- Custom widget plugins (`render.js`) run in the console page like the
  built-in renderers. They are **owner-installed code** — installable only by
  an authenticated session via Settings → Apps, the agent's CreateWidget
  tool, or a folder you place on disk yourself. There is deliberately no
  "install from a URL" path. The plugin contract requires escaping all
  interpolated text (`api.esc`) and forbids external scripts and network
  calls; ids are validated and sources size-capped.

## Self-evolution gating

The agent's ability to modify its own code is **off unless explicitly
enabled** (`ORB2_SELF_MODIFY_ENABLED=1`) and additionally requires the repo
and docker socket to be mounted into `orb2-api`. Changes are built and
validated in a throwaway sandbox container before promotion, and promotion
carries automatic rollback. Without the flag and the mounts, the
self-evolution tools refuse to run.

## Deployment posture

- The stack binds to the local host; remote access is opt-in via Tailscale
  (or the device-hostname path) and always stays behind OTP auth.
- Secrets live in a gitignored `.env` and Redis (optionally Vault); the
  Settings API echoes secret values only as set/unset, never in plaintext.
- Model revisions are pinned in the compose file so upstream re-uploads
  cannot silently change the weights being run.

---

# Security Policy

## Supported Versions

0rb is currently maintained on the latest `main` branch and the latest
release only.

| Version | Supported |
| ------- | --------- |
| Latest release | :white_check_mark: |
| Older releases | :x: |
| Unreleased forks / modified builds | :x: |

Security fixes are generally released in the next patch version and may also
be landed directly on `main` before a release is published.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in 0rb, please report
it privately.

Preferred reporting channel:

- GitHub Security Advisories / private vulnerability reporting for this
  repository

Please include:

- a clear description of the issue
- affected version, commit, or environment
- reproduction steps or a proof of concept
- impact assessment
- any suggested remediation, if available

Please do **not** open a public issue for an unpatched vulnerability.

## Response Process

Our general goals are:

- initial triage acknowledgment within 7 days
- follow-up after validation when we can reproduce the issue
- coordinated disclosure after a fix is available

Severity, exploitability, and maintenance bandwidth may affect timelines.

## Disclosure and CVEs

Valid reports may be fixed privately first and disclosed after a patch is
available. If a report is accepted and significant enough to warrant formal
tracking, we may publish a GitHub Security Advisory and request or assign a
CVE. CVE issuance is not guaranteed for every report.

## Scope

This policy applies to:

- the 0rb source code in this repository
- official release artifacts published from this repository

This policy does not cover:

- third-party model providers, endpoints, or hosted services
- local misconfiguration on the reporter's machine
- vulnerabilities in unofficial forks, mirrors, or downstream repackages
