# Dependency Vulnerability Scan Guide

How to scan project dependencies for known vulnerabilities, per ecosystem.

---

## Node.js (npm / yarn / pnpm)

```bash
# npm audit (built-in)
npm audit --json 2>/dev/null

# yarn audit
yarn audit --json 2>/dev/null

# pnpm audit
pnpm audit --json 2>/dev/null
```

**Indicators:** `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

**Severity mapping:** npm uses `info`, `low`, `moderate`, `high`, `critical` -- map to LOW, LOW, MEDIUM, HIGH, CRITICAL.

---

## Python (pip / pipenv / poetry)

```bash
# pip-audit (install if needed: pip install pip-audit)
pip-audit --format json 2>/dev/null

# safety (install if needed: pip install safety)
safety check --json 2>/dev/null

# If neither available, check PyPI advisories manually for packages in:
#   requirements.txt, Pipfile.lock, poetry.lock, pyproject.toml
```

**Indicators:** `requirements.txt`, `Pipfile`, `pyproject.toml`, `poetry.lock`

---

## .NET (C#)

```bash
# dotnet list package --vulnerable
dotnet list package --vulnerable --format json 2>/dev/null

# If --format json not available:
dotnet list package --vulnerable 2>/dev/null
```

**Indicators:** `*.csproj`, `*.sln`, `packages.config`, `Directory.Packages.props`

---

## Java (Maven / Gradle)

```bash
# Maven dependency-check plugin
mvn org.owasp:dependency-check-maven:check -Dformat=JSON 2>/dev/null

# Gradle
gradle dependencyCheckAnalyze 2>/dev/null
```

**Indicators:** `pom.xml`, `build.gradle`, `build.gradle.kts`

---

## Reachability Classification

For each dependency vulnerability found, classify reachability:

| Classification | Criteria | Action |
|---------------|----------|--------|
| `REACHABLE` | Codebase imports AND calls the vulnerable function/API | Report as confirmed finding |
| `POTENTIALLY_REACHABLE` | Codebase imports the package but unclear if vulnerable API is used | Report with note |
| `NOT_REACHABLE` | Package is installed but the vulnerable API is not used | Report as informational only |

### How to Assess Reachability

1. **Search for imports** of the vulnerable package
2. **Identify the vulnerable API** from the advisory (e.g., "lodash.template()")
3. **Search codebase** for calls to that specific API
4. **Trace call chain** to confirm it's reachable from application code (not just dev tooling)

---

## Output Format

Normalize all dependency findings to:

```json
{
  "id": "DEP-001",
  "package": "<package name>",
  "version": "<installed version>",
  "ecosystem": "npm|pip|nuget|maven",
  "vulnerability_id": "CVE-YYYY-NNNNN or GHSA-xxxx",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "cvss": 0.0,
  "fixed_version": "<version with fix>",
  "reachability": "REACHABLE|POTENTIALLY_REACHABLE|NOT_REACHABLE",
  "reachability_evidence": "<file:line where vulnerable API is called>"
}
```

---

## When Audit Tools Are Unavailable

If no audit tool is installed for the detected ecosystem:

1. Note it in the report: "Dependency audit tool not available for <ecosystem>"
2. Manually check the lock file for packages with known high-profile CVEs
3. Recommend the user install the appropriate audit tool
