# Security Analysis Examples

Few-shot examples demonstrating how to analyze code, produce findings, and identify false positives.

---

## Example 1: SQL Injection (HIGH - Tampering) -- CONFIRMED

### Input Code (Python)

```python
# File: src/api/users.py, lines 45-52
def search_users(request):
    query = request.GET.get('q', '')
    sql = f"SELECT * FROM users WHERE name LIKE '%{query}%'"
    cursor = connection.cursor()
    cursor.execute(sql)
    return cursor.fetchall()
```

### Analysis

1. **Input source:** `query` from `request.GET.get('q')` -- user-controlled HTTP parameter
2. **Data flow:** `query` -> f-string interpolation -> `sql` -> `cursor.execute()`
3. **Sanitization:** None
4. **Mitigations:** No ORM, no prepared statement, no input validation middleware
5. **Exploitability:** Direct SQL execution with user input = easily exploitable

### Finding

```json
{
  "id": "VULN-001",
  "severity": "HIGH",
  "stride_category": "Tampering",
  "vulnerability_type": "SQL Injection",
  "cwe": "CWE-89",
  "file": "src/api/users.py",
  "line_range": "45-52",
  "analysis": "User input from request.GET is directly interpolated into SQL query using f-string without sanitization or parameterization.",
  "exploit_scenario": "Attacker submits q=test%' OR '1'='1 to retrieve all users.",
  "recommended_fix": "Use parameterized queries: cursor.execute('SELECT * FROM users WHERE name LIKE %s', (f'%{query}%',))",
  "confidence": 0.95
}
```

---

## Example 2: IDOR (HIGH - Information Disclosure) -- CONFIRMED

### Input Code (Express.js)

```javascript
// File: src/routes/documents.js, lines 23-30
router.get('/api/documents/:id', async (req, res) => {
  const document = await Document.findById(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  res.json(document);
});
```

### Analysis

1. **Input source:** `req.params.id` -- URL parameter, user-controlled
2. **Data flow:** `req.params.id` -> `Document.findById()` -> response
3. **Authorization:** No ownership check -- any user can access any document by ID
4. **Mitigations:** None visible

### Finding

```json
{
  "id": "VULN-002",
  "severity": "HIGH",
  "stride_category": "InfoDisclosure",
  "vulnerability_type": "Insecure Direct Object Reference (IDOR)",
  "cwe": "CWE-639",
  "file": "src/routes/documents.js",
  "line_range": "23-30",
  "analysis": "Endpoint retrieves document by ID without verifying the authenticated user has access.",
  "recommended_fix": "Add ownership check: Document.findOne({ _id: req.params.id, userId: req.user.id })",
  "confidence": 0.9
}
```

---

## Example 3: XSS via dangerouslySetInnerHTML (HIGH - Tampering) -- CONFIRMED

### Input Code (React)

```jsx
// File: src/components/UserProfile.jsx, lines 12-20
function UserProfile({ user }) {
  return (
    <div className="profile">
      <h2>{user.name}</h2>
      <div className="bio" dangerouslySetInnerHTML={{ __html: user.bio }} />
    </div>
  );
}
```

### Analysis

1. **Input source:** `user.bio` -- user-editable field stored in database
2. **Data flow:** User input -> database -> API -> `dangerouslySetInnerHTML`
3. **Framework bypass:** `dangerouslySetInnerHTML` explicitly bypasses React's XSS protection
4. **Mitigations:** None (no DOMPurify or server-side sanitization)

### Finding

```json
{
  "id": "VULN-003",
  "severity": "HIGH",
  "stride_category": "Tampering",
  "vulnerability_type": "Cross-Site Scripting (XSS) - Stored",
  "cwe": "CWE-79",
  "file": "src/components/UserProfile.jsx",
  "line_range": "12-20",
  "analysis": "User bio rendered with dangerouslySetInnerHTML without sanitization. Stored XSS.",
  "recommended_fix": "Use DOMPurify: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(user.bio) }} or remove dangerouslySetInnerHTML entirely.",
  "confidence": 0.95
}
```

---

## Example 4: Command Injection (CRITICAL - Tampering) -- CONFIRMED

### Input Code (Python)

```python
# File: src/utils/image_processor.py, lines 15-20
def resize_image(filename, width, height):
    output_file = f"resized_{filename}"
    command = f"convert {filename} -resize {width}x{height} {output_file}"
    os.system(command)
    return output_file
```

### Analysis

1. **Input source:** `filename` -- potentially from user upload
2. **Data flow:** Parameter -> f-string -> `os.system()` (shell execution)
3. **Sanitization:** None
4. **Exploitability:** Shell metacharacters in filename -> arbitrary command execution

### Finding

```json
{
  "id": "VULN-004",
  "severity": "CRITICAL",
  "stride_category": "Tampering",
  "vulnerability_type": "Command Injection",
  "cwe": "CWE-78",
  "file": "src/utils/image_processor.py",
  "line_range": "15-20",
  "analysis": "User-controlled filename interpolated into shell command via os.system(). Shell metacharacters enable arbitrary command execution.",
  "exploit_scenario": "Filename 'img.jpg; rm -rf / #' executes destructive command.",
  "recommended_fix": "Use subprocess with list args: subprocess.run(['convert', filename, '-resize', f'{width}x{height}', output_file], check=True)",
  "confidence": 0.95
}
```

---

## Example 5: Safe Parameterized Query -- FALSE POSITIVE

### Input Code (Python)

```python
# File: src/api/products.py, lines 30-38
def get_products_by_category(category_id):
    query = "SELECT * FROM products WHERE category_id = %s AND active = TRUE"
    cursor = connection.cursor()
    cursor.execute(query, (category_id,))
    return cursor.fetchall()
```

### Analysis

1. **Pattern:** SQL query with `%s` placeholder
2. **Execution:** `cursor.execute(query, (category_id,))` -- parameterized
3. **Safety:** Database driver handles escaping; this is the recommended safe pattern

### Result: **NO FINDING** -- Parameterized query is safe.

---

## Example 6: Authorization in Middleware -- FALSE POSITIVE

### Input Code (TypeScript)

```typescript
// File: src/routes/documents.ts, lines 15-25
router.get('/api/documents/:id',
  requireAuth,
  requireOwnership('document'),
  async (req, res) => {
    const document = await Document.findById(req.params.id);
    res.json(document);
  }
);
```

### Analysis

1. **Pattern:** Direct object access by ID (looks like IDOR)
2. **Middleware:** `requireAuth` + `requireOwnership('document')` applied before handler
3. **Protection:** Authorization handled in middleware layer, not in handler

### Result: **NO FINDING** -- Authorization exists in middleware. Document it as a reviewed-and-safe pattern.

---

## Example 7: JWT-Sourced ID -- FALSE POSITIVE

### Input Code (JavaScript)

```javascript
// File: src/repositories/orderRepository.js, lines 23-25
return db.query(`SELECT * FROM orders WHERE user_id = ${userId}`);
```

### Analysis

1. **Pattern:** String interpolation in SQL (looks like SQL injection)
2. **Input source:** `userId` comes from `req.user.id` extracted from server-signed JWT
3. **Control:** User cannot modify their JWT payload without the signing secret
4. **Assessment:** Input is server-controlled, not user-controlled

### Result: **NO FINDING** -- While parameterized queries would be better practice, the input is from a trusted source (signed JWT). Note as informational if desired, but not a vulnerability.
