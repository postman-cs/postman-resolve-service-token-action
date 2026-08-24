import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertNpmSriMatch,
  computeNpmSri,
  expectedArtifactNames,
  sha256Hex,
  validateManifest,
  validateTagVersion,
  verifyReleaseArtifacts
} from '../scripts/verify-release-artifacts.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function stageReleaseDirectory(packageVersion = '2.0.4') {
  const directory = mkdtempSync(join(tmpdir(), 'release-artifact-'));
  const packRoot = mkdtempSync(join(tmpdir(), 'release-pack-'));
  const packageDir = join(packRoot, 'package');
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@postman/onboarding-resolve-service-token', version: packageVersion })
  );
  const tarball = join(directory, 'release.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', packRoot, 'package']);
  const sea = `postman-resolve-service-token-${packageVersion}-linux-x64`;
  const seaBytes = Buffer.from(`sea-bytes-${packageVersion}`);
  writeFileSync(join(directory, sea), seaBytes);
  writeFileSync(join(directory, `${sea}.sha256`), `${digest(seaBytes)}  ${sea}\n`);
  const artifacts = expectedArtifactNames(packageVersion).map((path) => ({
    path,
    sha256: digest(readFileSync(join(directory, path)))
  }));
  const manifest = {
    schema_version: 1,
    repository: 'postman-cs/example',
    commit_sha: 'abc',
    tag: `v${packageVersion}`,
    package_name: '@postman/onboarding-resolve-service-token',
    package_version: packageVersion,
    artifacts
  };
  writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(packRoot, { recursive: true, force: true });
  return { directory, manifest, sea, tarball };
}

function extractInlineVerifier() {
  const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
  const match = releaseWorkflow.match(
    /name: Verify checksummed release artifacts\n(?:[\s\S]*?)run: \|\n\s+node --input-type=module - <<'NODE'\n([\s\S]*?)\n\s+NODE/
  );
  expect(match?.[1]).toBeTruthy();
  const scriptDir = mkdtempSync(join(tmpdir(), 'inline-verify-'));
  const inlinePath = join(scriptDir, 'inline-verify.mjs');
  writeFileSync(inlinePath, match?.[1] ?? '');
  return { scriptDir, inlinePath };
}

function runInline(inlinePath: string, directory: string) {
  try {
    return {
      ok: true as const,
      stdout: execFileSync(process.execPath, [inlinePath], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'postman-cs/example',
          GITHUB_SHA: 'abc',
          GITHUB_REF_NAME: 'v2.0.4'
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    return {
      ok: false as const,
      stderr: String(err.stderr ?? ''),
      message: String(err.message ?? error)
    };
  }
}

describe('release artifact verifier', () => {
  it('accepts a bound manifest and rejects a single wrong checksum specifically', () => {
    const { directory, manifest } = stageReleaseDirectory();
    try {
      expect(() =>
        validateManifest(manifest, directory, {
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4',
          packageName: '@postman/onboarding-resolve-service-token',
          packageVersion: '2.0.4'
        })
      ).not.toThrow();

      const wrongChecksum = {
        ...manifest,
        artifacts: manifest.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, sha256: digest('wrong-bytes-for-checksum') } : artifact
        )
      };
      expect(() =>
        validateManifest(wrongChecksum, directory, {
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/^checksum mismatch for /);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid schema, unsafe paths, missing artifacts, identity drift, and bad sidecars', () => {
    const schema = stageReleaseDirectory();
    try {
      expect(() =>
        validateManifest({ ...schema.manifest, schema_version: 2 }, schema.directory, {
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/invalid manifest schema/);
    } finally {
      rmSync(schema.directory, { recursive: true, force: true });
    }

    const unsafe = stageReleaseDirectory();
    try {
      expect(() =>
        validateManifest(
          {
            ...unsafe.manifest,
            artifacts: unsafe.manifest.artifacts.map((artifact, index) =>
              index === 0 ? { ...artifact, path: '../escape.tgz' } : artifact
            )
          },
          unsafe.directory,
          { repository: 'postman-cs/example', commitSha: 'abc', tag: 'v2.0.4' }
        )
      ).toThrow(/unsafe artifact path/);
    } finally {
      rmSync(unsafe.directory, { recursive: true, force: true });
    }

    const missing = stageReleaseDirectory();
    try {
      unlinkSync(join(missing.directory, 'release.tgz'));
      expect(() =>
        validateManifest(missing.manifest, missing.directory, {
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/missing artifact release\.tgz/);
    } finally {
      rmSync(missing.directory, { recursive: true, force: true });
    }

    const wrongName = stageReleaseDirectory();
    try {
      writeFileSync(
        join(wrongName.directory, 'release-manifest.json'),
        `${JSON.stringify({ ...wrongName.manifest, package_name: '@postman/wrong-package' }, null, 2)}\n`
      );
      expect(() =>
        verifyReleaseArtifacts({
          directory: wrongName.directory,
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/manifest package_name mismatch/);
    } finally {
      rmSync(wrongName.directory, { recursive: true, force: true });
    }

    const wrongVersion = stageReleaseDirectory();
    try {
      writeFileSync(
        join(wrongVersion.directory, 'release-manifest.json'),
        `${JSON.stringify({ ...wrongVersion.manifest, package_version: '9.9.9' }, null, 2)}\n`
      );
      expect(() =>
        verifyReleaseArtifacts({
          directory: wrongVersion.directory,
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/manifest package_version mismatch/);
    } finally {
      rmSync(wrongVersion.directory, { recursive: true, force: true });
    }

    const sidecar = stageReleaseDirectory();
    try {
      writeFileSync(join(sidecar.directory, `${sidecar.sea}.sha256`), `${digest('nope')}  ${sidecar.sea}\n`);
      const refreshed = {
        ...sidecar.manifest,
        artifacts: expectedArtifactNames('2.0.4').map((path) => ({
          path,
          sha256: digest(readFileSync(join(sidecar.directory, path)))
        }))
      };
      expect(() =>
        validateManifest(refreshed, sidecar.directory, {
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).toThrow(/SEA sidecar digest does not match executable and manifest/);
    } finally {
      rmSync(sidecar.directory, { recursive: true, force: true });
    }
  });

  it('accepts only exact and zero-patch minor publish tags', () => {
    expect(() => validateTagVersion('v2.0.4', '2.0.4')).not.toThrow();
    expect(() => validateTagVersion('v2.1', '2.1.0')).not.toThrow();
    expect(() => validateTagVersion('v2.0', '2.0.4')).toThrow(/does not match/);
  });

  it('computes and asserts npm SHA-512 SRI identity', () => {
    const bytes = Buffer.from('release-tarball-bytes');
    const sri = computeNpmSri(bytes);
    expect(sri).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
    expect(() => assertNpmSriMatch(sri, sri)).not.toThrow();
    expect(() => assertNpmSriMatch(sri, computeNpmSri(Buffer.from('other')))).toThrow(
      /existing npm package integrity differs from staged tarball/
    );
  });

  it('verifies a staged directory through the CLI entrypoint contract', () => {
    const { directory } = stageReleaseDirectory();
    try {
      expect(() =>
        verifyReleaseArtifacts({
          directory,
          repository: 'postman-cs/example',
          commitSha: 'abc',
          tag: 'v2.0.4'
        })
      ).not.toThrow();
      expect(sha256Hex('x')).toHaveLength(64);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('executes the production inline verifier for valid, checksum, extra-file, and sidecar failures', () => {
    const { scriptDir, inlinePath } = extractInlineVerifier();
    try {
      const valid = stageReleaseDirectory();
      try {
        expect(runInline(inlinePath, valid.directory).ok).toBe(true);
      } finally {
        rmSync(valid.directory, { recursive: true, force: true });
      }

      const tampered = stageReleaseDirectory();
      try {
        writeFileSync(join(tampered.directory, 'release.tgz'), Buffer.from('tampered'));
        const result = runInline(inlinePath, tampered.directory);
        expect(result.ok).toBe(false);
        expect(result.stderr).toMatch(/checksum mismatch/);
      } finally {
        rmSync(tampered.directory, { recursive: true, force: true });
      }

      const extra = stageReleaseDirectory();
      try {
        writeFileSync(join(extra.directory, 'extra.bin'), 'nope');
        const result = runInline(inlinePath, extra.directory);
        expect(result.ok).toBe(false);
        expect(result.stderr).toMatch(/unexpected filesystem entry/);
      } finally {
        rmSync(extra.directory, { recursive: true, force: true });
      }

      const sidecar = stageReleaseDirectory();
      try {
        writeFileSync(join(sidecar.directory, `${sidecar.sea}.sha256`), `${digest('bad')}  ${sidecar.sea}\n`);
        const refreshed = {
          ...sidecar.manifest,
          artifacts: expectedArtifactNames('2.0.4').map((path) => ({
            path,
            sha256: digest(readFileSync(join(sidecar.directory, path)))
          }))
        };
        writeFileSync(join(sidecar.directory, 'release-manifest.json'), `${JSON.stringify(refreshed, null, 2)}\n`);
        const result = runInline(inlinePath, sidecar.directory);
        expect(result.ok).toBe(false);
        expect(result.stderr).toMatch(/SEA sidecar digest does not match executable and manifest/);
      } finally {
        rmSync(sidecar.directory, { recursive: true, force: true });
      }
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });
});
