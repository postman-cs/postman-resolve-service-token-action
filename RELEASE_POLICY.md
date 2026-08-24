# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. `dist/` is gitignored build output and is never committed on branches or main. Release tags carry the bundle because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use the exact `v<version>` tag matching `package.json`, and also `vN.M` when the package patch is zero.
- The rolling `vN` alias for the current major moves only to the latest compatible immutable release and never regresses to an older target.
- Existing immutable release tags are never force-pushed or rewritten.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump, rebuild `dist/`, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Before planning another cut, auto-release reconciles the latest immutable tag
when its GitHub release is missing or its rolling alias has not advanced. It
does not duplicate an active release run, and a successful release completion
resumes planning.

Do not push `vX.Y.Z` tags by hand. The pre-push hook refuses them, because a
hand-pushed tag becomes a public identifier before any gate has run against it.

To see what the next merge would cut:

```sh
node scripts/release-cut.mjs --plan
```

After the tag push, `release.yml` verifies and publishes:

1. Checks out the tagged commit in `verify-package` (ubuntu) and `verify-package-windows` (windows-latest); both consume committed tag bytes with no rebuild. Windows asserts dist present and untouched before and after `node --run test`.
2. Publish runs only when both verify jobs succeed, verifies local release artifacts, creates the authoritative GitHub Release, then attempts npm publication with provenance and advances the rolling `v2` alias.

The parent relationship is the audit link to reviewed source. The release bytes reproduce with `npm ci && npm run bundle` at the tag commit's parent. A bare tag without committed `dist/` fails artifact verification.

## npm package

The CLI publishes as `@postman/onboarding-resolve-service-token` with versions that match the immutable GitHub release tag. GitHub Releases remain authoritative if npm publication is unavailable; use `backfill-npm.yml` to publish immutable release assets once access exists. npm package identity is verified after a successful publish. The rolling `vN` alias updates the action channel and skips npm publishing.

## Compatibility

The current-major `vN` channel keeps action inputs and outputs compatible unless a security fix requires narrower behavior. New optional inputs can be added under `vN` when they preserve existing workflows.

## Security fixes

Security fixes ship on the latest immutable tag for the current major and move onto the rolling `vN` alias. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).
