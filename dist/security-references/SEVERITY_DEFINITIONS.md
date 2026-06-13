# Severity Definitions & CVSS Scoring Guide

---

## Severity Levels

| Severity | CVSS Range | Criteria | Examples |
|----------|-----------|----------|----------|
| **CRITICAL** | 9.0 - 10.0 | Immediately exploitable, severe impact, no auth required | RCE, auth bypass, hardcoded production secrets, data breach |
| **HIGH** | 7.0 - 8.9 | Exploitable with some conditions, significant impact | SQL injection, stored XSS, IDOR, privilege escalation |
| **MEDIUM** | 4.0 - 6.9 | Requires specific conditions, moderate impact | Reflected XSS, CSRF, info disclosure, missing security headers |
| **LOW** | 0.1 - 3.9 | Difficult to exploit, low impact | Verbose errors, best practice violations, minor config issues |

---

## CVSS 3.1 Base Metrics

### Attack Vector (AV)

| Value | Code | Description |
|-------|------|-------------|
| Network | N | Exploitable over the network (most web vulnerabilities) |
| Adjacent | A | Requires adjacent network access (same LAN/WiFi) |
| Local | L | Requires local system access |
| Physical | P | Requires physical access to the device |

### Attack Complexity (AC)

| Value | Code | Description |
|-------|------|-------------|
| Low | L | No special conditions needed; attack is straightforward |
| High | H | Requires specific conditions, timing, or chained exploits |

### Privileges Required (PR)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No authentication needed |
| Low | L | Requires basic user account |
| High | H | Requires admin or elevated privileges |

### User Interaction (UI)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No user interaction needed (automated exploit) |
| Required | R | Victim must click a link, open a file, or take action |

### Scope (S)

| Value | Code | Description |
|-------|------|-------------|
| Unchanged | U | Impact limited to the vulnerable component |
| Changed | C | Impact extends beyond the vulnerable component (e.g., XSS affecting other users) |

### Impact Metrics (C/I/A)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No impact on this dimension |
| Low | L | Limited impact (partial data access, minor modification) |
| High | H | Total impact (full data access, complete modification, full disruption) |

---

## Common CVSS Vectors

| Vulnerability | Typical CVSS Vector | Score |
|--------------|---------------------|-------|
| Unauthenticated RCE | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` | 9.8 |
| SQL Injection (no auth) | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N` | 9.1 |
| Auth bypass | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N` | 9.1 |
| Stored XSS | `AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N` | 5.4 |
| Reflected XSS | `AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` | 6.1 |
| IDOR (data access) | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N` | 6.5 |
| IDOR (data modification) | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N` | 8.1 |
| Missing auth on admin | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` | 9.8 |
| Hardcoded credentials | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N` | 9.1 |
| Command injection | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` | 8.8 |
| Path traversal (read) | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N` | 6.5 |
| Path traversal (write) | `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N` | 6.5 |
| CSRF | `AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N` | 6.5 |
| Open redirect | `AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` | 6.1 |
| Verbose error messages | `AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N` | 5.3 |
| Missing security headers | `AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N` | 4.2 |

---

## Exploitability Ratings

| Rating | Criteria |
|--------|----------|
| `EASY` | Standard tools, publicly known technique, no special conditions |
| `MEDIUM` | Requires specific conditions, timing, or chaining multiple steps |
| `HARD` | Requires insider knowledge, rare conditions, or advanced techniques |
| `NOT_EXPLOITABLE` | Theoretical vulnerability, not practically exploitable in context |

---

## Severity Adjustment Rules

The validated severity may differ from the initial assessment:

| Condition | Adjustment |
|-----------|------------|
| No authentication required + easy exploit | Upgrade by 1 level |
| Framework protection partially mitigates | Downgrade by 1 level |
| Requires chaining with another vulnerability | Downgrade by 1 level |
| Affects PII or credentials | Upgrade by 1 level |
| Only affects the attacker's own data | Downgrade to LOW |
| Test/dev environment only | Downgrade to LOW or exclude |
