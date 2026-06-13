# False Positive Filtering Rules

Rules for filtering out false positives and low-confidence findings. Apply these before reporting any finding.

---

## Hard Exclusions

Automatically exclude findings that match any of these categories:

1. **DoS without business impact** -- Denial of Service without significant, demonstrable business impact.
2. **Properly secured disk secrets** -- Secrets stored on disk if properly secured (encrypted, restricted permissions).
3. **Rate limiting concerns** -- Informational only; do not report as vulnerability.
4. **Memory/CPU exhaustion** -- Without a clear, practical attack path from external input.
5. **Missing input validation** -- Without proven downstream impact (the validation gap alone is not a finding).
6. **GitHub Actions without untrusted input** -- Action vulnerabilities without a specific untrusted input path.
7. **Theoretical race conditions** -- Without a practical exploit scenario.
8. **Memory safety in safe languages** -- Memory safety issues in memory-safe languages (C#).
9. **Test file findings** -- Vulnerabilities found only in test files (`*.test.*`, `*.spec.*`, `__tests__/`).
10. **Log injection/spoofing** -- Log injection concerns without demonstrated escalation.
11. **Partial SSRF** -- SSRF where attacker only controls the path (not host or protocol).
12. **AI prompt injection** -- User-controlled content in AI/LLM prompts (unless the system executes returned code).
13. **ReDoS without demonstrated impact** -- Regex DoS without a demonstrated catastrophic input.
14. **Documentation file findings** -- Findings in markdown, text, or documentation files.
15. **Missing audit logs** -- Informational only; do not report as vulnerability.

---

## Trusted Input Precedents

These inputs are considered trusted and should NOT trigger findings:

| Input Source | Reason |
|-------------|--------|
| Environment variables | Set by ops/infra, not user-controlled |
| CLI flags / arguments | Provided by the operator, not external users |
| Server-signed JWT claims | Cryptographically verified, cannot be tampered |
| UUIDs | Unguessable; enumeration is impractical |
| Config files on disk | Deployed by CI/CD, not user-modifiable at runtime |

---

## Framework Safety Precedents

These frameworks provide automatic protection unless explicitly bypassed:

| Framework/Pattern | Safe Unless |
|-------------------|-------------|
| React JSX `{variable}` | Using `dangerouslySetInnerHTML` |
| Angular template binding | Using `bypassSecurityTrustHtml` |
| Vue template `{{ variable }}` | Using `v-html` directive |
| Django ORM queries | Using `.raw()` or `.extra()` with string interpolation |
| SQLAlchemy ORM | Using `text()` with f-strings |
| Prisma queries | Using `$queryRawUnsafe()` |
| Entity Framework LINQ | Using `FromSqlRaw()` with interpolation |
| Parameterized queries | Always safe regardless of framework |

---

## Confidence Scoring

| Score | Meaning | Action |
|-------|---------|--------|
| 0.9 - 1.0 | Certain exploit path; could generate working PoC | Report |
| 0.8 - 0.9 | Clear vulnerability pattern with known exploitation technique | Report |
| 0.7 - 0.8 | Suspicious pattern requiring specific conditions to exploit | **Do NOT report** |
| Below 0.7 | Speculative; likely has unseen mitigations | **Do NOT report** |

**Threshold: Only report findings with confidence >= 0.8**

---

## Mitigation Verification Checklist

Before confirming a finding, check these mitigation layers:

1. **Same function** -- Is there validation/sanitization in the same function?
2. **Calling function** -- Does the caller validate before passing data?
3. **Middleware** -- Is there route-level middleware (auth, validation, rate limiting)?
4. **Framework** -- Does the framework auto-protect against this class of vulnerability?
5. **Infrastructure** -- Is there a WAF, CSP, or other infra-level protection?
6. **Type system** -- Does the type system prevent the attack (e.g., strongly typed query params)?

If ANY layer adequately mitigates the vulnerability, mark it as a false positive with evidence.
