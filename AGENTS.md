# postman-resolve-service-token-action

Credential producer for the Postman Enterprise Automation Suite. Mints fresh service-account access token + resolves team ID in CI, ready to hand to onboarding action or store as repo secrets. Dual entry: GitHub Action (`dist/index.cjs`) + CLI (`dist/cli.cjs`, bin `postman-resolve-service-token`).

## Structure

```
src/
  index.ts                # Core: SA token exchange + team-ID resolution + shared runner
  main.ts                 # GitHub Action entry: reads inputs, runs core, sets outputs
  cli.ts                  # CLI adapter; writes JSON/dotenv
  pmak-diagnostics.ts     # Rejected-mint PMAK identity diagnosis helpers
  action-version.ts       # Version string for telemetry/logs
tests/
```

## Commands

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run verify:bundle  # build + runtime-shape check
```

## Key Behaviors

- Mints short-lived service-account access token; token = suite's preferred Bifrost/governance credential, can expire, so this action runs first in CI.
- Resolves team ID by calling `GET /me` with the minted token (`resolveTeamIdAndIdentity` in `index.ts`) and reading the team field from the response.
- `account_type` for this producer always `service` in suite telemetry.
- Outputs masked before logging; minted token never appears clear in logs or artifacts.

## Gotchas

- `index.ts` holds real token-exchange logic; `main.ts` = Action shell, `cli.ts` = non-GitHub adapter. Wire any pre-output logic into both entries.
- esbuild bundles `--target=node24`; `dist/` is gitignored build output and is never committed on branches. `npm run bundle` chmods `dist/cli.cjs` executable.
- Release tags carry `dist/` on tag-only commit parented on reviewed main SHA; main never carries bundled bytes.

## CI

`.github/workflows/ci.yml` runs two required peer jobs (no `needs:`):

- **gate** (ubuntu): `npm run bundle` once, then parallel lint/test/typecheck/`node scripts/verify-dist-artifact.mjs`/actionlint/(PR)commitlint.
- **windows**: rebuilds `dist/` once (dist-off-main scaffolding), then `node --run test` for OS runtime (`.cmd`, spawn, path).

Release `verify-package-windows` checks out tag and runs suite against committed tag bytes with **no** rebuild; publish needs both Ubuntu and Windows verify jobs.

See workspace-root `../../docs/CI.md` for shared rationale.

## Releases

Tags are an **output** of passing run, never input. Never push release tag by hand; `.githooks/pre-push` rejects it.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps, rebuilds `dist/`, runs typecheck/lint/test, commits, re-verifies committed bytes, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- Release commit lives only on tag. `main` never carries bundled bytes; tag-only commit parents reviewed main SHA and carries `dist/`.
- `RELEASE_POLICY.md` holds full contract.
- `main` requires pull requests and green `gate` + `Windows gate` + `build-and-smoke` checks (admins included, no bypass). Merge with `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge --delete-branch`; never `--admin`.
- `.githooks/pre-push` runs typecheck, lint, and test before every branch push.

## Anti-Patterns

- Never hardcode secrets, tokens, or absolute paths in durable memory
