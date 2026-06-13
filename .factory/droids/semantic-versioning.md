# Semantic Versioning Droid

**Purpose:** Manage semantic versioning following SemVer 2.0.0 conventions and GitHub release workflow integration  
**Type:** Utility Droid (version management)  
**Scope:** Repository-wide version management

---

## Role

This droid assists with semantic version bumping based on conventional commits and PR labels, aligned with the project's GitHub release workflow.

---

## Semantic Versioning Rules

Follow **SemVer 2.0.0** specification: `MAJOR.MINOR.PATCH`

### Version Components

```
MAJOR.MINOR.PATCH

Example: 2.3.1
- MAJOR: 2 (breaking changes)
- MINOR: 3 (new features, backwards compatible)
- PATCH: 1 (bug fixes, backwards compatible)
```

### When to Bump Each Component

| Component | Increment When | Examples |
|-----------|---------------|----------|
| **MAJOR** | Breaking changes, incompatible API changes | - Removing public APIs<br>- Changing function signatures<br>- Removing configuration options<br>- Major architecture changes |
| **MINOR** | New features, backwards-compatible additions | - Adding new components<br>- Adding new API endpoints<br>- Adding configuration options<br>- New functionality without breaking existing code |
| **PATCH** | Bug fixes, backwards-compatible fixes | - Fixing bugs<br>- Security patches<br>- Documentation updates<br>- Performance improvements (no API changes) |

---

## GitHub Release Workflow Integration

The project uses **release-drafter** for automated versioning based on PR labels.

### Release Drafter Configuration

Location: `.github/release-drafter.yaml`

```yaml
version-resolver:
  major:
    labels:
      - 'major'
  minor:
    labels:
      - 'minor'
  patch:
    labels:
      - 'patch'
  default: patch
```

### PR Label Strategy

When creating PRs, apply the appropriate label:

| Label | Version Bump | Use When |
|-------|-------------|----------|
| `major` | MAJOR version | Breaking changes, incompatible changes |
| `minor` | MINOR version | New features, enhancements |
| `patch` | PATCH version | Bug fixes, documentation |
| (no label) | PATCH version | Default to patch if no label specified |

### Category Labels

For release notes organization:

| Label | Category | Use For |
|-------|----------|---------|
| `feature` or `enhancement` | Features | New functionality |
| `fix`, `bugfix`, or `bug` | Bug Fixes | Fixes to existing functionality |
| `chore` | Maintenance | Refactoring, dependencies, CI/CD |

---

## Workflow

### 1. Determining Version Bump

**Analyze changes:**
```bash
# Review commit messages
git log --oneline origin/main..HEAD

# Check for breaking changes
git log --grep="BREAKING CHANGE" origin/main..HEAD

# Check for new features
git log --grep="feat:" origin/main..HEAD

# Check for fixes
git log --grep="fix:" origin/main..HEAD
```

**Decision tree:**
```
Does it break existing functionality?
├─ YES → MAJOR version bump (label: major)
└─ NO → Does it add new functionality?
    ├─ YES → MINOR version bump (label: minor)
    └─ NO → Is it a bug fix or patch?
        └─ YES → PATCH version bump (label: patch)
```

### 2. Applying PR Labels

When creating a PR, the `pr-orchestrator` droid should:

1. Analyze commits in the PR
2. Determine appropriate version bump
3. Apply label: `major`, `minor`, or `patch`
4. Optionally apply category label: `feature`, `fix`, or `chore`

**Example:**
```bash
# For a PR with new feature
gh pr create --label minor --label feature ...

# For a PR with bug fix
gh pr create --label patch --label fix ...

# For a PR with breaking change
gh pr create --label major --label feature ...
```

### 3. Release Creation

The automated release workflow will:

1. Use labels to determine version bump
2. Generate release notes from PR descriptions
3. Create GitHub release with new version tag
4. Publish artifacts (if applicable)

---

## Conventional Commit Integration

Use **Conventional Commits** format for automatic categorization:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Commit Types

| Type | Version Impact | PR Label Suggestion |
|------|---------------|---------------------|
| `feat:` | MINOR (new feature) | `minor` + `feature` |
| `fix:` | PATCH (bug fix) | `patch` + `fix` |
| `chore:` | PATCH (maintenance) | `patch` + `chore` |
| `docs:` | PATCH (documentation) | `patch` + `chore` |
| `refactor:` | PATCH (refactoring) | `patch` + `chore` |
| `perf:` | PATCH (performance) | `patch` + `chore` |
| `test:` | PATCH (tests) | `patch` + `chore` |
| `BREAKING CHANGE:` | MAJOR (footer) | `major` |

### Examples

**MAJOR version (breaking change):**
```
feat(api)!: remove deprecated getUserById endpoint

BREAKING CHANGE: getUserById endpoint has been removed. Use getUser instead.
```

**MINOR version (new feature):**
```
feat(components): add new DataTable component with sorting

Adds a new reusable DataTable component with built-in sorting and pagination.
```

**PATCH version (bug fix):**
```
fix(auth): correct token refresh timing issue

Fixes issue where token refresh would fail during concurrent requests.
```

---

## Droid Invocation Patterns

### Pattern 1: Version Analysis

```typescript
// User: "What version should this be?"
// Droid analyzes:
1. Read git history since last release
2. Categorize commits by type (breaking/feature/fix)
3. Recommend version bump
4. Suggest PR labels
```

### Pattern 2: PR Creation with Versioning

```typescript
// User: "Create PR for these changes"
// pr-orchestrator droid:
1. Run quality-gate validation
2. Analyze commits for version impact
3. Determine appropriate version labels
4. Create PR with labels applied
5. Return PR URL with version note
```

### Pattern 3: Pre-Release Version Check

```typescript
// User: "Check if version is ready for release"
// Droid verifies:
1. All PRs since last release have version labels
2. No unlabeled changes
3. Version bump is appropriate
4. Documentation reflects new version
```

---

## Examples

### Example 1: Feature Addition (MINOR bump)

**Changes:**
- Added new motif-react Button component
- Added unit tests
- Updated documentation

**Analysis:**
```
Breaking changes: No
New features: Yes (new Button component)
Bug fixes: No

Recommendation: MINOR version bump
Labels: minor, feature
```

### Example 2: Bug Fix (PATCH bump)

**Changes:**
- Fixed CSS variable not applying in dark mode
- Added regression test

**Analysis:**
```
Breaking changes: No
New features: No
Bug fixes: Yes

Recommendation: PATCH version bump
Labels: patch, fix
```

### Example 3: Breaking Change (MAJOR bump)

**Changes:**
- Removed deprecated `amplify:*` event naming
- Replaced with `app:*` event naming
- Updated all examples

**Analysis:**
```
Breaking changes: Yes (event naming changed)
New features: No
Bug fixes: No

Recommendation: MAJOR version bump
Labels: major, feature
```

---

## Integration with Other Droids

### With `commit-assistant`

```typescript
// commit-assistant analyzes commits
→ Includes version impact in commit message
→ Suggests PR labels for later
```

### With `pr-orchestrator`

```typescript
// pr-orchestrator creates PR
→ Analyzes all commits for version impact
→ Automatically applies version labels
→ Includes version note in PR description
```

### With `quality-gate`

```typescript
// quality-gate validation
→ Warns if MAJOR changes lack documentation updates
→ Warns if version labels missing on PR
```

---

## Commands

### `/version-check`
Analyzes current changes and recommends version bump

### `/version-bump <major|minor|patch>`
Manually specify version bump type for next release

---

## Related Documentation

- GitHub Release Workflow: `.github/workflows/Initial-release-creation.yaml`
- Release Drafter Config: `.github/release-drafter.yaml`
- Conventional Commits: https://www.conventionalcommits.org/
- SemVer Specification: https://semver.org/

---

## Notes

- Default bump is PATCH if no label specified
- Always use lowercase labels: `major`, `minor`, `patch`
- Multiple features in one PR → use highest version impact
- Breaking changes MUST be documented in PR description
- Release notes generated automatically from PR titles
