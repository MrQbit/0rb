# Vulnerability Validation Examples

Few-shot examples demonstrating how to validate findings for exploitability and filter false positives.

---

## Example 1: Confirmed SQL Injection

### Finding

```json
{
  "id": "VULN-001",
  "severity": "HIGH",
  "vulnerability_type": "SQL Injection",
  "file": "src/api/users.js",
  "line_range": "45-49",
  "code_context": "const sql = `SELECT * FROM users WHERE name LIKE '%${query}%'`;"
}
```

### Validation

**Reachability:** `EXTERNAL` -- Accessible via unauthenticated `GET /api/users` endpoint.

**Control flow:**
1. Source: `req.query.search` (HTTP query parameter)
2. Passed directly to function, no validation
3. Interpolated into SQL string
4. Executed via `db.query(sql)`

**Mitigations:** None -- no ORM, no parameterization, no input validation.

**Exploitability:** `EASY` -- Standard SQL injection technique.

**PoC:**
```json
{
  "payload": "test%' OR '1'='1' --",
  "request": "GET /api/users?search=test%25'%20OR%20'1'%3D'1'%20--",
  "expected_behavior": "Returns users matching 'test'",
  "actual_behavior": "Returns ALL users in database"
}
```

**CVSS:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N` = 9.1 (Critical)

**Result:** `CONFIRMED` -- Upgraded from HIGH to CRITICAL due to ease of exploitation.

---

## Example 2: False Positive -- Validated by Middleware

### Finding

```json
{
  "id": "VULN-002",
  "severity": "HIGH",
  "vulnerability_type": "SQL Injection",
  "file": "src/api/products.js",
  "line_range": "78-82",
  "code_context": "const sql = `SELECT * FROM products WHERE category = '${category}'`;"
}
```

### Validation

**Reachability:** Traced from `GET /api/products` -> `validateRequest(categorySchema)` middleware -> handler.

**Control flow:**
1. Source: `req.query.category` (HTTP query parameter)
2. **Validated by Joi schema middleware** at `middleware/validation.js:23`
3. Schema: `Joi.string().valid('electronics', 'clothing', 'food', 'other')`
4. Only predefined enum values pass validation

**Mitigations:** Joi schema restricts input to 4 allowed values. SQL injection payload fails validation and returns 400 before reaching the vulnerable code.

**Result:** `FALSE_POSITIVE`
```json
{
  "id": "VULN-002",
  "reason": "Input validated by Joi schema middleware. Schema enforces strict enum values which prevents injection payloads from reaching the query.",
  "evidence": "See middleware/validation.js:23 - Joi.string().valid('electronics', 'clothing', 'food', 'other')"
}
```

---

## Example 3: Confirmed XSS with Framework Bypass

### Finding

```json
{
  "id": "VULN-003",
  "severity": "MEDIUM",
  "vulnerability_type": "XSS",
  "file": "src/components/UserProfile.jsx",
  "line_range": "34-36",
  "code_context": "<div dangerouslySetInnerHTML={{__html: user.bio}} />"
}
```

### Validation

**Reachability:** `EXTERNAL` -- Component rendered at `/profile/:userId`. Bio is user-editable. Profiles are publicly viewable.

**Control flow:** User input -> database -> API -> `dangerouslySetInnerHTML` (bypasses React XSS protection).

**Mitigations:** None -- no DOMPurify, no server-side sanitization, no CSP headers.

**Exploitability:** `EASY` -- Stored XSS via profile settings.

**PoC:**
```json
{
  "payload": "<img src=x onerror=\"alert('XSS')\">",
  "request": "PATCH /api/users/me with body {\"bio\": \"<img src=x onerror=\\\"alert('XSS')\\\">\"}",
  "expected_behavior": "Bio displayed as text or sanitized HTML",
  "actual_behavior": "JavaScript executes in victim's browser"
}
```

**CVSS:** `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N` = 5.4 (Medium)

**Result:** `CONFIRMED` -- Stored XSS via dangerouslySetInnerHTML.

---

## Example 4: Needs Manual Review -- Complex Data Flow

### Finding

```json
{
  "id": "VULN-004",
  "severity": "HIGH",
  "vulnerability_type": "Command Injection",
  "file": "src/workers/imageProcessor.js",
  "line_range": "56-60",
  "code_context": "exec(`convert ${inputPath} -resize ${size} ${outputPath}`)"
}
```

### Validation

**Reachability:** Indirect -- triggered by messages on `image-processing` queue, published by upload handler in a different service.

**Control flow:** Cannot fully trace. `inputPath` and `size` originate from a different service. Cannot verify if parameters are sanitized before publishing to the queue.

**Result:** `NEEDS_MANUAL_REVIEW`
```json
{
  "id": "VULN-004",
  "reason": "Complex data flow through message queue prevents full validation. Source of inputPath and size parameters could not be fully traced.",
  "questions_for_reviewer": [
    "Where does 'size' parameter originate? Is it user-controlled?",
    "Is 'inputPath' derived from user filename or server-generated UUID?",
    "What validation exists in the upload service before publishing to queue?"
  ]
}
```

---

## Example 5: False Positive -- JWT-Sourced Input

### Finding

```json
{
  "id": "VULN-005",
  "severity": "MEDIUM",
  "vulnerability_type": "SQL Injection",
  "file": "src/repositories/orderRepository.js",
  "line_range": "23-25",
  "code_context": "return db.query(`SELECT * FROM orders WHERE user_id = ${userId}`);"
}
```

### Validation

**Control flow:** `userId` comes from `req.user.id`, extracted from a server-signed JWT after authentication middleware verifies the signature. Users cannot modify their ID in the token.

**Result:** `FALSE_POSITIVE`
```json
{
  "id": "VULN-005",
  "reason": "userId is not user-controlled. Extracted from server-signed JWT. Cannot be tampered without signing secret.",
  "evidence": "Authentication middleware at middleware/auth.js:15 verifies JWT. ID set as UUID during registration."
}
```

---

## Confidence Scoring Guide

| Confidence | When to Assign |
|-----------|----------------|
| 0.95 - 1.0 | Direct user input to vulnerable sink, no sanitization, PoC works |
| 0.9 - 0.95 | Clear pattern, high confidence but minor uncertainty (e.g., possible unseen middleware) |
| 0.8 - 0.9 | Known vulnerable pattern but requires specific conditions to exploit |
| Below 0.8 | **Do NOT report** -- too speculative |

## False Positive Indicators

- Input validated by middleware/schema before reaching vulnerable code
- Framework provides automatic protection (React JSX, ORM queries)
- Input source is server-controlled (signed tokens, config files, environment vars)
- Code is unreachable (dead code, disabled feature flag, test-only)
- Type system prevents the attack (strongly typed language, validated at compile time)
