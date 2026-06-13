---
name: security-pr-review
description: Review code changes for security vulnerabilities using STRIDE threat modeling. Use when asked to review a PR, scan changes for vulnerabilities, or check code before merge
keywords: security review, review pr, pr security, vulnerability review, stride review, security scan pr, pr vulnerabilities
---

# PR Security Review

Analyze code changes for security vulnerabilities using STRIDE-based threat modeling. Uses ORB2's built-in tools (Read, Grep, Glob, Bash) to analyze code directly -- no external CLI required.

SECURITY_REFS_DIR is resolved from the ORB2_SECURITY_REFS_DIR environment variable. Reference files are in that directory.

## When to Use

- User asks to review code for security issues
- User wants a security check before merging
- User says "security review" in context of code changes

## Instructions

### Step 1: Identify Changes

Use `Bash` to get the diff of recent changes:
```bash
git diff HEAD~1 --stat
git diff HEAD~1
```

Or if the user specifies a range:
```bash
git diff <base>..<head>
```

Also get the list of changed files:
```bash
git diff HEAD~1 --name-only
```

### Step 2: Read Changed Files

Use `Read` to get the full content of each changed file. Analyze both the diff and full file context to understand data flows.

### Step 3: Load STRIDE Checklist

Read the STRIDE checklist from `$SECURITY_REFS_DIR/STRIDE_CHECKLIST.md` for the full analysis methodology covering:
- **S** - Spoofing Identity
- **T** - Tampering with Data
- **R** - Repudiation
- **I** - Information Disclosure
- **D** - Denial of Service
- **E** - Elevation of Privilege

### Step 4: Analyze Changed Files

For each changed file, systematically check for vulnerabilities. For each potential finding, trace the data flow from input source to vulnerable sink.

Read `$SECURITY_REFS_DIR/ANALYSIS_EXAMPLES.md` for examples of how to analyze code and produce findings.

### Step 5: Map CWE Identifiers

For each finding, assign the appropriate CWE identifier using `$SECURITY_REFS_DIR/CWE_REFERENCE.md`.

### Step 6: Filter False Positives

Apply the rules in `$SECURITY_REFS_DIR/FALSE_POSITIVE_RULES.md`:
1. Check all hard exclusion rules
2. Verify existing mitigations (middleware, framework protections, validation)
3. Score confidence (0.0 - 1.0)
4. **Only report findings with confidence >= 0.8**

### Step 7: Assess Severity

| Severity | Criteria |
|----------|----------|
| CRITICAL | Remote code execution, auth bypass, data breach |
| HIGH | SQL injection, stored XSS, IDOR, privilege escalation |
| MEDIUM | Reflected XSS, CSRF, info disclosure, missing headers |
| LOW | Best practice violations, verbose errors |

### Step 8: Generate Output

Create `security-findings.json` in the working directory following the schema in `$SECURITY_REFS_DIR/findings-schema.json`.

### Step 9: Report

Present a markdown summary:
- Severity breakdown table
- Each finding with file, line, type, analysis, and recommended fix
- False positives noted with reasoning
- Overall assessment: safe to merge / needs attention / blocks merge

## Merge Recommendation

| Condition | Recommendation |
|-----------|---------------|
| Any CRITICAL | **Block merge** |
| HIGH only | **Request changes** |
| MEDIUM/LOW only | **Comment** -- safe to merge |
| No findings | **Approve** |
