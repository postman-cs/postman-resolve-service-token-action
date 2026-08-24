import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const release = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const backfill = readFileSync(join(process.cwd(), '.github/workflows/backfill-npm.yml'), 'utf8');
const sea = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

function job(name: string) {
  return release.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

describe('release workflow contract', () => {
  it('cuts an annotated immutable tag containing dist without modifying main', () => {
    const cut = job('cut');
    expect(cut).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.existing_tag != true }}"
    );
    expect(cut).toContain('package.json');
    expect(cut).toContain('npm run bundle');
    expect(cut).toContain('node scripts/verify-dist-artifact.mjs');
    expect(cut).toContain('git add -f dist');
    expect(cut).toMatch(/git commit/);
    expect(cut).toMatch(/git tag -a/);
    expect(cut).toMatch(/git push[^\n]*refs\/tags\//);
    expect(cut).not.toMatch(/git push[^\n]*(?:refs\/heads\/|\bmain\b)/);
    expect(release).toContain('needs.cut.outputs.tag || github.ref_name');
    expect(release).toContain('needs.cut.outputs.sha || github.sha');
  });

  it('consumes an auto-cut tag without running the legacy manual cut job', () => {
    expect(release).toContain('existing_tag:');
    expect(release).toContain('type: boolean');
    const classify = job('classify');
    expect(classify).toContain('inputs.existing_tag == true');
    expect(classify).toContain('ref: ${{ needs.cut.outputs.tag || github.ref }}');
  });

  it('classifies with the policy helper before install and serializes immutable release work without cancellation', () => {
    expect(release).toContain('group: release-${{ github.repository }}');
    expect(release).toContain('cancel-in-progress: false');
    const classify = job('classify');
    expect(classify).toContain('node scripts/release-policy.mjs classify');
    expect(classify).toContain('release_kind: ${{ steps.release_tag.outputs.release_kind }}');
    expect(classify).toContain('package_version: ${{ steps.release_tag.outputs.package_version }}');
    expect(classify).toContain('npm_publish: ${{ steps.release_tag.outputs.npm_publish }}');
    expect(classify).toContain('actions/checkout@v7');
    expect(classify).toContain('actions/setup-node@v7');
    expect(classify.indexOf('actions/checkout@v7')).toBeLessThan(classify.indexOf('actions/setup-node@v7'));
    expect(classify.indexOf('actions/setup-node@v7')).toBeLessThan(classify.indexOf('release-policy.mjs classify'));
    expect(classify).not.toContain('npm ci');
    expect(job('verify-package')).toContain("needs.classify.outputs.release_kind == 'immutable'");
    expect(job('verify-package-windows')).toContain("needs.classify.outputs.release_kind == 'immutable'");
    expect(job('publish')).toContain(
      "needs.classify.outputs.release_kind == 'immutable' && needs.verify-package.result == 'success' && needs.verify-package-windows.result == 'success' && needs.build-sea.result == 'success'"
    );
    expect(job('advance-major-alias')).toContain("needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success'");
    expect(job('dispatch-live-monitor')).toContain("needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success'");
  });

  it('consumes tagged dist on Windows without rebuild before publish', () => {
    const win = job('verify-package-windows');
    const publish = job('publish');
    expect(win).toContain('runs-on: windows-latest');
    expect(win).toContain('needs: [cut, classify]');
    expect(win).toContain('ref: ${{ needs.cut.outputs.tag || github.ref }}');
    expect(win).toContain('id: windows-node-modules');
    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...release.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(win).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(win).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(win).not.toContain('restore-keys');
    expect(win).toContain('npm ci --prefer-offline --no-audit --no-fund');
    expect(win).not.toContain('npm run bundle');
    expect(win).not.toContain('npm run build');
    expect(win).toContain('node scripts/assert-release-dist-untouched.mjs');
    expect(win.match(/node scripts\/assert-release-dist-untouched\.mjs/g) ?? []).toHaveLength(2);
    expect(win).toContain('- run: node --run test');
    const guardNeedle = 'node scripts/assert-release-dist-untouched.mjs';
    const firstGuard = win.indexOf(guardNeedle);
    const secondGuard = win.indexOf(guardNeedle, firstGuard + 1);
    const testIdx = win.indexOf('- run: node --run test');
    expect(firstGuard).toBeLessThan(testIdx);
    expect(secondGuard).toBeGreaterThan(testIdx);
    expect(publish).toContain('needs: [cut, classify, verify-package, verify-package-windows, build-sea]');
    expect(publish).toContain("needs.verify-package-windows.result == 'success'");
    expect(publish).toContain("needs.build-sea.result == 'success'");
  });

  it('uses unprivileged artifact construction and artifact-only privileged publication', () => {
    const verify = job('verify-package');
    const buildSea = job('build-sea');
    const publish = job('publish');
    expect(verify).toContain('contents: read');
    expect(verify).not.toContain('id-token: write');
    expect(verify).not.toContain('npm run bundle');
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run dist node scripts/verify-dist-artifact.mjs');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('gate:$n=pass');
    expect(verify).toContain('gate:$n=fail');
    expect(verify).not.toContain('npm publish');
    expect(verify).not.toContain('action-gh-release');
    expect(verify).not.toContain('git push');
    expect(verify).not.toContain('scripts/build-sea.sh');
    expect(verify).not.toContain('scripts/assert-sea-proxy.mjs');
    expect(verify).toContain('release.tgz');
    expect(verify).toContain('release_tgz_sha256: ${{ steps.artifact-digests.outputs.release_tgz_sha256 }}');
    expect(verify).toContain('Record trusted tarball digest');
    expect(verify.indexOf('Record trusted tarball digest')).toBeLessThan(verify.indexOf('upload-artifact@v7'));
    expect(verify).toContain('release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(verify).toContain('path: release.tgz');
    expect(buildSea).toContain('contents: read');
    expect(buildSea).not.toContain('id-token: write');
    expect(buildSea).toContain('scripts/build-sea.sh');
    expect(buildSea).toContain("NODE_OPTIONS='--this-flag-does-not-exist'");
    expect(buildSea).toContain('scripts/assert-sea-proxy.mjs');
    expect(buildSea).toContain('sea-binary-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(buildSea).toContain('build/sea/postman-resolve-service-token-*-linux-x64');
    expect(buildSea).toContain('build/sea/postman-resolve-service-token-*-linux-x64.sha256');
    expect(publish).toContain('contents: write');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('published: ${{ steps.npm-publish.outputs.published }}');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('cache: npm');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/^\s*- run: npm pack/m);
    expect(publish).toContain('EXPECTED_RELEASE_TGZ_SHA256: ${{ needs.verify-package.outputs.release_tgz_sha256 }}');
    expect(publish).toContain('Authenticate transferred tarball');
    expect(publish).toContain('release.tgz hash does not match trusted verify-package output');
    expect(publish).toContain('sea-binary-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(publish).toContain('Stage release manifest with SEA allowlist');
    expect(publish).toContain('release-manifest.json');
    expect(publish).toContain("const paths = ['release.tgz', sea, `${sea}.sha256`]");
    expect(publish.indexOf('Stage release manifest with SEA allowlist')).toBeLessThan(
      publish.indexOf('Verify checksummed release artifacts')
    );
    expect(publish).toContain('Verify checksummed release artifacts');
    expect(publish).toContain('exact artifact allowlist mismatch');
    expect(publish).toContain('tarball package identity mismatch');
    expect(publish).toContain('SEA sidecar digest does not match executable and manifest');
    expect(publish.indexOf('Verify checksummed release artifacts')).toBeLessThan(
      publish.indexOf('softprops/action-gh-release')
    );
    expect(publish).toContain(
      `ACTUAL=$(node -e "const {createHash}=require('node:crypto'); console.log('sha512-'+createHash('sha512').update(require('node:fs').readFileSync('release.tgz')).digest('base64'))")`
    );
    expect(publish).toContain(
      `test "$INTEGRITY" = "$ACTUAL" || { echo '::error::existing npm package integrity differs from staged tarball'; exit 1; }`
    );
    expect(publish.indexOf('softprops/action-gh-release')).toBeLessThan(
      publish.indexOf('Publish or verify npm package identity')
    );
    expect(publish).toContain('id: npm-publish');
    expect(publish).toContain('continue-on-error: true');
    expect(publish).toContain('set -euo pipefail');
    expect(publish).toContain("sed -i '/_authToken/d'");
    expect(publish).toContain('echo "published=false" >> "$GITHUB_OUTPUT"');
    expect(publish).toContain('echo "published=true" >> "$GITHUB_OUTPUT"');
    expect(publish.indexOf("createHash('sha512')")).toBeLessThan(
      publish.indexOf('npm publish ./release.tgz --provenance --access public')
    );
    expect(publish.indexOf('existing npm package integrity differs from staged tarball')).toBeLessThan(
      publish.indexOf('npm publish ./release.tgz --provenance --access public')
    );
    expect(publish.indexOf('npm publish ./release.tgz --provenance --access public')).toBeGreaterThan(
      publish.indexOf('softprops/action-gh-release')
    );
    expect(publish).toContain('npm view "$PKG_NAME@$PKG_VERSION" dist.integrity');
    expect(publish).toContain('name: Verify npm registry identity');
    expect(publish).toContain("if: steps.npm-publish.outputs.published == 'true'");
    expect(publish).toContain('name: Report npm publish skipped');
    expect(publish).toContain("if: steps.npm-publish.outputs.published != 'true'");
    expect(publish).toContain('recover via backfill-npm.yml once publish access exists');
    expect(release.indexOf('  publish:')).toBeLessThan(release.indexOf('  advance-major-alias:'));
  });

  it('advances aliases from scoped ls-remote identity before force-push without full history fetch', () => {
    expect(job('build-sea')).toContain('scripts/assert-sea-proxy.mjs');
    expect(job('build-sea')).toContain("NODE_OPTIONS='--this-flag-does-not-exist'");
    expect(sea).toContain('scripts/assert-sea-proxy.mjs');
    expect(sea).toContain('.sha256');
    const alias = job('advance-major-alias');
    expect(alias).not.toContain('fetch-depth: 0');
    expect(alias).not.toContain('git for-each-ref');
    expect(alias).not.toContain('objectname:peel');
    expect(alias).not.toContain('git rev-parse');
    expect(alias).not.toContain('git tag -fa "$MAJOR" "$GITHUB_SHA"');
    expect(alias).toContain('set -euo pipefail');
    expect(alias.indexOf('set -euo pipefail')).toBeLessThan(alias.indexOf('git ls-remote'));
    expect(alias).toContain('git ls-remote --tags origin "$MAJOR" "$MAJOR^{}" "$MAJOR.*"');
    expect(alias).not.toContain('--refs');
    expect(alias).toContain('release-policy.mjs decide-alias');
    expect(alias).toContain('--candidate-version');
    expect(alias).toContain('--major');
    expect(alias.indexOf('git ls-remote')).toBeLessThan(alias.indexOf('git tag -fa'));
    expect(alias.indexOf('decide-alias')).toBeLessThan(alias.indexOf('git tag -fa'));
    expect(alias.indexOf('decide-alias')).toBeLessThan(alias.indexOf('git push origin "$MAJOR" --force'));
    expect(alias).toContain('::notice::$NOTICE');
    expect(alias).not.toContain('sort -V');
  });

  it('uses pinned binary actionlint without Go across release and sibling workflows', () => {
    expect(release).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(release).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    for (const workflow of [release, ci, sea]) {
      expect(workflow).not.toContain('actions/setup-go');
      expect(workflow).not.toContain('go install github.com/rhysd/actionlint');
    }
  });

  it('backfills only immutable new-scope release assets without changing release channels', () => {
    expect(backfill).toContain('workflow_dispatch:');
    expect(backfill).toContain('Ordered space-separated immutable tags, oldest first');
    expect(backfill).toContain('contents: read');
    expect(backfill).toContain('id-token: write');
    expect(backfill).not.toContain('actions/checkout');
    expect(backfill).toContain("PKG_NAME='@postman/onboarding-resolve-service-token'");
    expect(backfill).toContain('gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern \'release.tgz\'');
    expect(backfill).toContain('test "$PACKAGE_NAME" = "$PKG_NAME"');
    expect(backfill).toContain('test "$PACKAGE_VERSION" = "${TAG#v}"');
    expect(backfill).toContain('npm publish "$TARBALL" --provenance --access public --tag backfill');
    expect(backfill).toContain('npm view "$PKG_NAME" versions --json');
    expect(backfill).toContain('npm dist-tag add "$PKG_NAME@$HIGHEST" latest');
  });
});
