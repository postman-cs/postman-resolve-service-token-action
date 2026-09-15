# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, boxes with no package-registry access — this action ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

"Self-contained" means the *runtime* is bundled — it is not network-isolated. This action's whole job is to call the Postman API to mint a token, so the run needs outbound access to the API host (see [Network requirements](#network-requirements)).

The binary is built and smoke-tested natively in CI on every release (`.github/workflows/release.yml`) and attached as a GitHub Release asset. It carries the same code as the `action.yml` and npm CLI paths.

- **Current target:** `linux-x64` (glibc). Other targets (linux-arm64, win-x64, darwin-arm64) are not built yet.
- **First release with the binary:** the first `v*` tag published after this lands. Pin an explicit released version in the examples below.

## Get the binary

Download the release asset and mark it executable. Pin an explicit version:

```bash
VERSION=2.0.3   # example: use a release that carries the binary
ASSET="postman-resolve-service-token-${VERSION}-linux-x64"
BASE_URL="https://github.com/postman-cs/postman-resolve-service-token-action/releases/download/v${VERSION}"
curl -fsSLO "${BASE_URL}/${ASSET}"
curl -fsSLO "${BASE_URL}/${ASSET}.sha256"
shasum -a 256 -c "${ASSET}.sha256"
chmod +x "$ASSET"
mv "$ASSET" postman-resolve-service-token

./postman-resolve-service-token --version   # -> matches ${VERSION}
```

If the repository or release is private, the browser-style URL above returns an HTML login page instead of the binary. Fetch it through the GitHub API with a token that has `contents:read`, or — recommended for locked-down environments — **mirror the asset once into your own artifact store** (Artifactory, Nexus, S3) and have CI pull it from there. That keeps the build offline from GitHub entirely and gives you a stable internal URL.

## Prove self-containment

The binary embeds its own runtime and never consults `PATH` for `node`. You can prove that with an empty environment:

```bash
# Reaches the CLI's own input validation with no Node on PATH:
env -i PATH=/nonexistent ./postman-resolve-service-token
# -> "postman-api-key is required when postman-access-token is not provided."
```

This is the same assertion the release workflow runs before publishing the asset.

## What it does

This is the credential *producer* for the Postman Enterprise Automation Suite. Given a service-account PMAK it mints a fresh, short-lived access token and resolves the team ID, then prints the result as JSON on **stdout** (logs go to stderr, so stdout stays clean to capture):

```json
{
  "token": "pma_at_...",
  "team-id": "123456",
  "skipped": "false"
}
```

Hand `token` to the downstream onboarding/sync steps as their `POSTMAN_ACCESS_TOKEN` (and `team-id` where a team scope is needed).

## Credentials

The self-contained binary resolves each credential from three sources, highest precedence first:

1. A CLI flag — `--postman-api-key <key>`, `--postman-access-token <token>`
2. The GitHub Action input env var — `INPUT_POSTMAN_API_KEY`, `INPUT_POSTMAN_ACCESS_TOKEN`
3. A plain environment variable — `POSTMAN_API_KEY`, `POSTMAN_ACCESS_TOKEN`

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: bind the PMAK to `POSTMAN_API_KEY` and the binary picks it up. The `postman-api-key` must be a [service-account](https://learning.postman.com/docs/administration/service-accounts/) PMAK — the `/service-account-tokens` endpoint rejects personal user keys.

Mint against the API host for your region and pass the matching `--postman-region` — a US-minted token is not valid against the EU API and vice versa. `--postman-region us` (default) targets `api.getpostman.com`; `--postman-region eu` targets `api.eu.postman.com` ([EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/)).

Store the long-lived PMAK in your CI secret store and let this binary mint on demand; do not persist the short-lived access token it emits (TTL ~1–1.5h).

## Network requirements

The binary bundles its runtime, but minting is an online operation. The agent needs outbound access to the selected Postman API host for the whole run.

Node 24 does not activate `HTTP_PROXY` / `HTTPS_PROXY` handling for `fetch` by default. On a proxy-only agent, enable it explicitly; `NO_PROXY` remains available for bypasses:

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="http://proxy.example:8080"
```

Do not put `--use-env-proxy` in `NODE_OPTIONS`: the SEA deliberately ignores `NODE_OPTIONS` so ambient Node flags cannot change its runtime. `NODE_USE_ENV_PROXY=1` is the supported switch for the binary.

| Host | Purpose |
| --- | --- |
| `api.getpostman.com` (US) / `api.eu.postman.com` (EU) | `POST /service-account-tokens` (mint) and `GET /me` (team resolution) |
| `api.getpostman-beta.com` | Same calls when `--postman-stack beta` is explicitly selected; beta does not support the EU region |
| `events.pm-cse.dev` | Best-effort anonymous completion telemetry; disable with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1` |
| `api.github.com` (or the host in `GITHUB_API_URL`) | Required only when `--write-github-secret true`; repository public-key lookup and encrypted secret writes through the GitHub REST Actions Secrets API |

The action does **not** touch the Bifrost/gateway/iapub hosts the sync actions use, and it makes **no runtime tool downloads** on any path. A host with no route to the selected Postman API host cannot mint. Only the package-registry and Node-runtime dependencies are eliminated; Postman connectivity is not.

The optional `--write-github-secret true` path is the exception: it is GitHub-repository specific and requires `GITHUB_REPOSITORY`, a token with repository secrets write permission, and egress to `GITHUB_API_URL` (default `https://api.github.com`). The binary fetches the repository public key, encrypts each value with sealed-box encryption, and writes it through the GitHub REST Actions Secrets API. It does not invoke `gh` or trust executables from `PATH`. Leave it off (the default) on non-GitHub agents.

## Run

Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`. The token lands on stdout as JSON:

```bash
out="$(POSTMAN_API_KEY="$PMAK" ./postman-resolve-service-token --postman-region us)"
# Capture the token for downstream steps (jq if available):
POSTMAN_ACCESS_TOKEN="$(printf '%s' "$out" | jq -r '.token')"
# ...or without jq:
POSTMAN_ACCESS_TOKEN="$(printf '%s' "$out" | grep -o '"token": *"[^"]*"' | head -1 | cut -d'"' -f4)"
export POSTMAN_ACCESS_TOKEN
```

- Pass `--postman-team-id` to skip team resolution when you already know it.
- `--write-github-secret` / `--access-token-secret-name` / `--github-token` are GitHub-repo specific; they require `GITHUB_REPOSITORY`, authorized credentials, and GitHub API egress, but no GitHub CLI. Omit them on other CI.

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. The Jenkins credential stores the long-lived **PMAK**; the binary mints a short-lived access token from it in-job. Do **not** store the access token itself — it expires in ~1–1.5h.

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    TOKEN_VERSION = '2.0.3'   // example: use a release that carries the binary
    POSTMAN_REGION = 'us'     // EU data residency: 'eu'
    NODE_USE_ENV_PROXY = '1'  // enables HTTP_PROXY / HTTPS_PROXY when configured
  }

  stages {
    stage('Fetch binary') {
      steps {
        sh '''
          set -eu
          # Prefer your internal mirror in locked-down environments:
          ASSET="postman-resolve-service-token-${TOKEN_VERSION}-linux-x64"
          BASE_URL="https://github.com/postman-cs/postman-resolve-service-token-action/releases/download/v${TOKEN_VERSION}"
          curl -fsSLO "$BASE_URL/$ASSET"
          curl -fsSLO "$BASE_URL/$ASSET.sha256"
          shasum -a 256 -c "$ASSET.sha256"
          chmod +x "$ASSET"
          mv "$ASSET" postman-resolve-service-token
          ./postman-resolve-service-token --version
        '''
      }
    }
    stage('Mint token') {
      steps {
        // Bind the PMAK and mint in one shell so the token stays in scope. The
        // binary reads the PMAK from POSTMAN_API_KEY (plain-env fallback, no flag).
        withCredentials([string(credentialsId: 'postman-api-key', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set +x          # Jenkins runs sh with -x by default; disable it BEFORE touching the PMAK
            set -eu
            out="$(./postman-resolve-service-token --postman-region "$POSTMAN_REGION")"
            TOKEN="$(printf '%s' "$out" | grep -o '"token": *"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
            # Hand $TOKEN to your downstream onboarding/sync step (e.g. export it or
            # write it to a stage-scoped file); do not echo it.
          '''
        }
      }
    }
  }
}
```

## Scope and limitations

- **Platform:** linux-x64 (glibc) only. arm64/Windows/macOS targets are not built yet.
- **Network:** not air-gapped — requires outbound access to the region-appropriate Postman API host to mint. See [Network requirements](#network-requirements).
- **Secret persistence:** `--write-github-secret true` uses repository public-key sealed-box encryption and the GitHub REST Actions Secrets API. It requires `GITHUB_REPOSITORY`, an authorized token, and egress to `GITHUB_API_URL` (default `https://api.github.com`), but no GitHub CLI or trusted `PATH`. Off by default; leave it off on non-GitHub agents.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-resolve-service-token-<version>-linux-x64`) also carries it.
