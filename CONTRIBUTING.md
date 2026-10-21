# Contributing to Resilient Edge Middleware

Thank you for helping improve REM. Please keep changes focused, reproducible,
and accompanied by evidence.

## Development Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

The Worker can be run locally with:

```bash
pnpm dev
```

For the local multi-service stack:

```bash
cd docker
docker compose up -d
```

## Pull Requests

- Open an issue describing the problem or proposed change before large work.
- Keep pull requests scoped to one concern.
- Add or update unit tests for behavior changes.
- Run `pnpm typecheck`, `pnpm test`, and the Wrangler dry-run bundle check.
- Update documentation when changing configuration, endpoints, or failure behavior.
- Avoid committing secrets, local state, generated `.wrangler` files, or large
  binary artifacts without discussion.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## Local-Only Controls

`CHAOS_MODE` and the `x-chaos-fail` header are local testing hooks. Do not enable
them in production or rely on them as production controls.
