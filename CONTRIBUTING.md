# Contributing to rak00n

Thanks for your interest. rak00n is a single-user, local-first AI assistant that
runs as a Docker Compose stack. Contributions that keep it simple, well-tested,
and easy to self-host are the most valuable.

> License note: rak00n is released under the [PolyForm Noncommercial 1.0.0](LICENSE)
> license. By contributing you agree your contributions are licensed under the
> same terms. Commercial use/redistribution requires written permission.

## Before you start

- Search existing [issues](https://github.com/MrQbit/rak00n/issues) and
  [discussions](https://github.com/MrQbit/rak00n/discussions) first.
- Use issues for confirmed bugs and actionable feature work; discussions for
  setup help and ideas.
- For larger changes, open an issue first so the scope is clear.
- For security reports, follow [SECURITY.md](SECURITY.md).

## Local setup

rak00n's agent API is a Bun app bundled to a single file; the rest of the stack
is Docker Compose. See [DEPLOYMENT.md](DEPLOYMENT.md) to bring it up.

```bash
bun install
bun run build:api        # bundle the agent API → dist/api.mjs
```

To rebuild + redeploy a service after a change:

```bash
docker build -t localhost:5001/rak00n-api:dev -f Dockerfile.api.dev .
docker compose -f docker-compose.spark.yml up -d rak00n-api
```

The web console is static (`web/public/`); rebuild the `ui` image to ship UI
changes.

## Development workflow

- Keep PRs focused on one problem or feature; avoid mixing unrelated cleanup.
- Preserve existing repo patterns unless the change is intentionally refactoring.
- New agent capabilities are usually a **connector** (`src/api/connectors/`) plus
  a **tool** (`src/api/tools/apiNativeTools.ts`) and, where it has a UI, a
  **widget** renderer (`web/public/orb-shell.js`). Gate tools on their config.
- Add or update tests when behavior changes; update docs when setup, commands,
  or user-facing behavior changes.

## Validation

```bash
bun run build:api
bun test ./path/to/file.test.ts     # focused tests
```

Verify a deployed change against the running stack (health + a real turn) before
opening a PR.

## Pull requests

Good PRs include: what changed, why, the user/developer impact, and the exact
checks you ran. Include screenshots for UI/console changes.

## Code style

- Follow the existing style in the files you touch; prefer small, readable
  changes over broad rewrites.
- Don't reformat unrelated files. Keep comments useful and concise.

## Community

Please be respectful and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
