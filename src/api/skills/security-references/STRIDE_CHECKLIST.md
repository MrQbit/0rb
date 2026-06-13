# STRIDE Security Analysis Checklist

Systematic checklist for analyzing code changes across all six STRIDE threat categories.

---

## S - Spoofing Identity

Check for weaknesses that allow attackers to impersonate users or services.

- [ ] Missing or weak authentication checks on endpoints
- [ ] Session handling vulnerabilities (predictable tokens, missing expiry)
- [ ] Token/credential exposure in code, logs, or responses
- [ ] Insecure cookie settings (missing httpOnly, Secure, SameSite)
- [ ] JWT vulnerabilities (none algorithm accepted, weak secrets, missing expiry)
- [ ] API key exposure in client-side code or version control
- [ ] Missing MFA on sensitive operations (password change, admin actions)
- [ ] OAuth/SSO misconfiguration (open redirect in callback, missing state param)

**Code patterns to flag:**
```
# Weak session token generation
token = str(random.randint(1000, 9999))

# Missing auth check
@app.route('/admin/users')
def admin_users():  # No @login_required

# JWT without verification
jwt.decode(token, options={"verify_signature": False})
```

---

## T - Tampering with Data

Check for injection attacks and unauthorized data modification.

### SQL Injection
- [ ] String concatenation or interpolation in SQL queries
- [ ] Dynamic query building without parameterization
- [ ] Raw SQL with user-controlled WHERE clauses

### Command Injection
- [ ] User input in `os.system()`, `exec()`, `eval()`, `subprocess` with `shell=True`
- [ ] Template strings in shell commands
- [ ] Unsanitized input in `child_process.exec()`

### XSS (Cross-Site Scripting)
- [ ] `dangerouslySetInnerHTML` without DOMPurify
- [ ] `innerHTML` assignment with user data
- [ ] Unescaped template rendering (`|safe`, `{!! !!}`, `<%- %>`)
- [ ] User input reflected in HTML attributes without encoding

### Mass Assignment
- [ ] Blind `Object.assign()` or spread from request body to model
- [ ] Missing allowlist for updateable fields
- [ ] Direct `req.body` passed to database update

### Path Traversal
- [ ] User input in file paths without `path.basename()` or validation
- [ ] Directory traversal sequences (`../`) not filtered
- [ ] User-controlled file extensions

### XXE (XML External Entities)
- [ ] XML parsing without disabling external entities
- [ ] XSLT processing with user-controlled stylesheets

---

## R - Repudiation

Check for insufficient audit trails.

- [ ] Missing audit logging for sensitive operations (CRUD on critical data)
- [ ] No logging of admin actions (user management, config changes)
- [ ] Log injection vulnerabilities (user input in log messages without sanitization)
- [ ] Missing timestamps or user identification in logs
- [ ] Logs that can be tampered with (no write-once/append-only)

---

## I - Information Disclosure

Check for data exposure to unauthorized parties.

### IDOR (Insecure Direct Object Reference)
- [ ] Direct object access by ID without ownership verification
- [ ] Sequential/predictable IDs exposing enumeration
- [ ] Missing tenant isolation in multi-tenant systems

### Data Leaks
- [ ] Verbose error messages exposing stack traces or DB details
- [ ] Hardcoded secrets, API keys, or credentials in source
- [ ] Sensitive data (PII, tokens) in log output
- [ ] Debug endpoints or dev tooling exposed in production
- [ ] Sensitive data in URL query parameters (logged by proxies/browsers)
- [ ] Overly broad API responses returning more fields than needed

---

## D - Denial of Service

Check for resource exhaustion vulnerabilities.

- [ ] Missing rate limiting on public endpoints
- [ ] Unbounded file upload size
- [ ] Unbounded query results (missing pagination/LIMIT)
- [ ] Regular expression denial of service (ReDoS) -- catastrophic backtracking
- [ ] Algorithmic complexity attacks (quadratic sorting, hash collisions)
- [ ] Missing request timeout configuration
- [ ] Synchronous blocking operations on critical paths

---

## E - Elevation of Privilege

Check for unauthorized access escalation.

- [ ] Missing authorization checks on endpoints (auth != authz)
- [ ] Role/permission bypass via parameter manipulation
- [ ] Privilege escalation through mass assignment of role fields
- [ ] Admin functionality accessible without admin role check
- [ ] Horizontal privilege escalation (accessing other users' resources)
- [ ] Vertical privilege escalation (user -> admin)
- [ ] RBAC bypass through direct API calls (bypassing UI restrictions)

**Code patterns to flag:**
```
# Missing authorization (has auth but no role check)
@login_required
def delete_user(user_id):  # No admin check
    User.delete(user_id)

# Role field in mass assignment
user.update(req.body)  # Could include { role: "admin" }
```

---

## Analysis Process Per Finding

For each potential vulnerability identified:

1. **Identify input source** -- Where does user-controlled data enter?
2. **Trace data flow** -- Follow input from source to sink (vulnerable function)
3. **Check sanitization** -- Is input validated, escaped, or parameterized along the way?
4. **Check mitigations** -- Middleware, framework protections, WAF rules?
5. **Assess exploitability** -- Can an attacker actually trigger this in practice?
6. **Determine severity** -- CRITICAL / HIGH / MEDIUM / LOW
7. **Score confidence** -- Only report if >= 0.8
