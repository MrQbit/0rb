---
name: security-codebase-scan
description: Perform a comprehensive security audit of a codebase using STRIDE threat modeling and dependency scanning. Use when asked to scan a project for vulnerabilities or run a security audit
keywords: security scan, security audit, codebase scan, vulnerability scan, stride scan, audit security, scan for vulnerabilities
---

# Codebase Security Scan

Comprehensive security audit of a project using STRIDE-based static analysis and dependency vulnerability scanning. Uses RAK00N's built-in tools (Read, Grep, Glob, Bash) -- no external CLI required.

SECURITY_REFS_DIR is resolved from the RAK00N_SECURITY_REFS_DIR environment variable.

## When to Use

- User asks to scan a project for security issues
- User requests a security audit of a codebase
- User wants to check dependencies for vulnerabilities

## Instructions

### Step 1: Detect Tech Stack

Use `Glob` and `Read` to identify the project's technology:

```
Glob: ["**/package.json", "**/requirements.txt", "**/pyproject.toml", "**/*.csproj", "**/pom.xml", "**/build.gradle", "**/go.mod", "**/Cargo.toml"]
```

Classify: Node.js, Python, .NET, Java, Go, Rust, etc.

### Step 2: Map Architecture

Use `Grep` and `Glob` to understand structure:
1. Identify components (src/, services/, apps/)
2. Find entry points (API routes, CLI commands, event listeners)
3. Identify data stores (database connections, cache configs)
4. Map external interfaces (HTTP endpoints, webhooks, file uploads)

### Step 3: STRIDE Analysis

Read `$SECURITY_REFS_DIR/STRIDE_CHECKLIST.md` for the methodology.
Read `$SECURITY_REFS_DIR/VULNERABILITY_PATTERNS.md` for stack-specific patterns.

For each source file in the target:
1. Check against vulnerability patterns for the detected stack
2. Trace data flows from entry points to sensitive operations
3. Identify trust boundary crossings

Cover all six STRIDE categories:
- **S** - Spoofing: auth bypass, session fixation, token forgery
- **T** - Tampering: injection, XSS, mass assignment
- **R** - Repudiation: audit logging gaps
- **I** - Information Disclosure: IDOR, data leaks, hardcoded secrets
- **D** - Denial of Service: resource exhaustion, ReDoS
- **E** - Elevation of Privilege: authz bypass, role manipulation

### Step 4: Dependency Vulnerability Scan

Run the appropriate dependency audit command:

| Stack | Command |
|-------|---------|
| Node.js | `npm audit --json` or `yarn audit --json` |
| Python | `pip audit --format json` or `safety check --json` |
| .NET | `dotnet list package --vulnerable --format json` |
| Java | Check `pom.xml` against known CVEs |
| Go | `go list -json -m all` |

Read `$SECURITY_REFS_DIR/DEPENDENCY_SCAN_GUIDE.md` for details.

For each dependency vulnerability:
1. Confirm the installed version is affected
2. Use `Grep` to search the codebase for usage of the vulnerable API
3. Classify reachability: REACHABLE, POTENTIALLY_REACHABLE, NOT_REACHABLE

### Step 5: Validate Findings

Read `$SECURITY_REFS_DIR/VALIDATION_EXAMPLES.md` for methodology.

For each finding:
1. **Reachability** -- Is the code reachable from external input?
2. **Control flow** -- Can an attacker control the input?
3. **Mitigations** -- Are there existing controls?
4. **Exploitability** -- EASY / MEDIUM / HARD / NOT_EXPLOITABLE
5. **Confidence** -- Only keep findings >= 0.8

### Step 6: Generate PoC for HIGH/CRITICAL

For confirmed HIGH or CRITICAL findings, generate a minimal proof-of-concept describing the payload, how to deliver it, expected vs actual behavior.

### Step 7: Calculate CVSS Scores

Read `$SECURITY_REFS_DIR/SEVERITY_DEFINITIONS.md` for CVSS 3.1 calculation.

### Step 8: Generate Output

Create `validated-findings.json` following the schema in `$SECURITY_REFS_DIR/findings-schema.json`.

### Step 9: Report

Present a markdown summary:
- Tech stack detected
- Files and dependencies scanned
- Severity breakdown table
- Each confirmed finding with: file, line, type, CVSS score, analysis, PoC, and fix
- Dependency findings with reachability assessment
- False positives noted
- Overall security posture assessment
