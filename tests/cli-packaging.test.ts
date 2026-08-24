import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const npmCliFallback = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function resolveNpmCliArgs(platform: NodeJS.Platform, npmExecPath: string | undefined): readonly string[] {
  if (platform !== 'win32') return [];
  return [npmExecPath || npmCliFallback];
}

const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmCliArgs = resolveNpmCliArgs(process.platform, process.env.npm_execpath);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];
const PACKED_BIN_TIMEOUT_MS = 20_000;
const PACKED_BIN_MAX_BUFFER = 1024 * 1024;
const PACKED_BIN_FIXED_ARGS = new Set(['--help', '--version']);
/** Reject cmd.exe metacharacters that could alter `/c` parsing. */
const CMD_REJECT_RE = /[\r\n"%!^&|<>]/;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function assertSandboxUnchanged(sandbox: string): Promise<void> {
  const written = await readdir(sandbox, { recursive: true });
  expect(written).toEqual([]);
}

type PackedBinInvocationPlan = Readonly<{
  file: string;
  args: readonly string[];
}>;

function assertSafeCmdToken(value: string, label: string): void {
  if (CMD_REJECT_RE.test(value)) {
    throw new Error(`${label} contains rejected cmd.exe metacharacters`);
  }
}

function quoteCmdArg(value: string): string {
  assertSafeCmdToken(value, 'cmd arg');
  return `"${value}"`;
}

/**
 * Cross-platform plan for invoking an npm-packed bin.
 * POSIX: execFile the executable directly.
 * Windows: execFile ComSpec/cmd.exe with `/d /s /c` and one quoted command payload
 * (never execFile the `.cmd` shim itself).
 */
function planPackedBinInvocation(
  binPath: string,
  args: readonly string[],
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }
): PackedBinInvocationPlan {
  const platform = options?.platform ?? process.platform;

  if (platform !== 'win32') {
    if (args.length !== 1 || !PACKED_BIN_FIXED_ARGS.has(args[0]!)) {
      throw new Error(`packed-bin args must be exactly --help or --version; got ${JSON.stringify(args)}`);
    }
    return { file: binPath, args: [...args] };
  }

  // Reject metacharacters before any cmd.exe argv is assembled.
  assertSafeCmdToken(binPath, 'binPath');
  for (const arg of args) {
    assertSafeCmdToken(arg, 'arg');
  }

  if (args.length !== 1 || !PACKED_BIN_FIXED_ARGS.has(args[0]!)) {
    throw new Error(`packed-bin args must be exactly --help or --version; got ${JSON.stringify(args)}`);
  }

  // Selected env only: explicit `{}` must not leak ambient ComSpec/COMSPEC.
  const env = options?.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  // AWS-proven shape: quote shim + fixed arg, then wrap the full payload for `/d /s /c`.
  const commandPayload = [quoteCmdArg(binPath), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
  return {
    file: comSpec,
    args: ['/d', '/s', '/c', `"${commandPayload}"`]
  };
}

async function runPackedBin(
  binPath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const plan = planPackedBinInvocation(binPath, args, { env: options.env });
  return execFileAsync(plan.file, [...plan.args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: PACKED_BIN_TIMEOUT_MS,
    maxBuffer: PACKED_BIN_MAX_BUFFER,
    ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {})
  });
}

describe('packed-bin invocation plan', () => {
  it('selects an explicit npm CLI entrypoint on Windows', () => {
    expect(resolveNpmCliArgs('linux', undefined)).toEqual([]);
    expect(resolveNpmCliArgs('win32', 'C:\\npm\\npm-cli.js')).toEqual(['C:\\npm\\npm-cli.js']);
    expect(resolveNpmCliArgs('win32', undefined)).toEqual([npmCliFallback]);
    expect(resolveNpmCliArgs('win32', undefined)[0]).not.toBe('');
    expect(npmCliFallback).toBe(
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    );
  });

  it('keeps POSIX as direct executable plus args', () => {
    const packedBinPath = '/tmp/prefix/node_modules/.bin/postman-resolve-service-token';
    expect(planPackedBinInvocation(packedBinPath, ['--help'], { platform: 'linux' })).toEqual({
      file: packedBinPath,
      args: ['--help']
    });
    expect(planPackedBinInvocation(packedBinPath, ['--version'], { platform: 'darwin' })).toEqual({
      file: packedBinPath,
      args: ['--version']
    });
  });

  it('selects ComSpec/COMSPEC/cmd.exe on win32 and never plans execFile of .cmd', () => {
    const packedBinPath = 'C:\\Program Files\\pkg\\postman-resolve-service-token.cmd';

    const viaComSpec = planPackedBinInvocation(packedBinPath, ['--help'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', COMSPEC: 'ignored.exe' }
    });
    expect(viaComSpec.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(viaComSpec.file.toLowerCase()).not.toMatch(/\.cmd$/);
    expect(viaComSpec.args).toEqual(['/d', '/s', '/c', `""${packedBinPath}" "--help""`]);

    const viaComspecEnv = planPackedBinInvocation(packedBinPath, ['--version'], {
      platform: 'win32',
      env: { COMSPEC: 'D:\\custom\\cmd.exe' }
    });
    expect(viaComspecEnv.file).toBe('D:\\custom\\cmd.exe');
    expect(viaComspecEnv.args).toEqual(['/d', '/s', '/c', `""${packedBinPath}" "--version""`]);

    const fallback = planPackedBinInvocation(packedBinPath, ['--help'], {
      platform: 'win32',
      env: {}
    });
    expect(fallback.file).toBe('cmd.exe');
    expect(fallback.args).toEqual(['/d', '/s', '/c', `""${packedBinPath}" "--help""`]);
    expect(fallback.args[3]).toContain('Program Files');
  });

  it('quotes a win32 path with spaces inside the single /c payload', () => {
    const packedBinPath = 'C:\\Users\\Test User\\node_modules\\.bin\\postman-resolve-service-token.cmd';
    const plan = planPackedBinInvocation(packedBinPath, ['--help'], {
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' }
    });
    expect(plan.args).toEqual(['/d', '/s', '/c', `""${packedBinPath}" "--help""`]);
    expect(plan.args[3]).toMatch(/^"".+" "--help""$/);
  });

  it('rejects cmd.exe metacharacters in win32 path and args before invoke', () => {
    const safe = 'C:\\pkg\\postman-resolve-service-token.cmd';
    const rejected = ['\r', '\n', '"', '%', '!', '^', '&', '|', '<', '>'] as const;

    for (const ch of rejected) {
      expect(() =>
        planPackedBinInvocation(`C:\\pkg\\evil${ch}tool.cmd`, ['--help'], {
          platform: 'win32',
          env: {}
        })
      ).toThrow(/rejected cmd\.exe metacharacters/);

      expect(() =>
        planPackedBinInvocation(safe, [`--help${ch}`], {
          platform: 'win32',
          env: {}
        })
      ).toThrow(/rejected cmd\.exe metacharacters/);
    }

    expect(() => planPackedBinInvocation(safe, ['--help'], { platform: 'win32', env: {} })).not.toThrow();

    expect(() => planPackedBinInvocation(safe, ['--unknown'], { platform: 'win32', env: {} })).toThrow(
      /packed-bin args must be exactly/
    );
    expect(() => planPackedBinInvocation(safe, ['--help', '--version'], { platform: 'linux' })).toThrow(
      /packed-bin args must be exactly/
    );
  });
});

describe('CLI packaging contract', () => {
  it('builds a Node shebang and executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    if (process.platform !== 'win32') {
      const mode = (await stat(cliPath)).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
      await access(cliPath, constants.X_OK);
    }

  });

  it('runs ./dist/cli.cjs --help and --version without credentials, network, or writes', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = await makeTempDir('postman-resolve-service-token-cli-sandbox-');
    const env = {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: '',
      POSTMAN_ACCESS_TOKEN: '',
      INPUT_POSTMAN_ACCESS_TOKEN: '',
      HOME: sandbox,
      TMPDIR: sandbox
    };

    const help = await execFileAsync(process.execPath, [cliPath, '--help'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-resolve-service-token/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = await execFileAsync(process.execPath, [cliPath, '--version'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(version.stdout.trim()).toBe(packageJson.version);

    await assertSandboxUnchanged(sandbox);
  }, 20_000);

  it('prefers CLI credential flags over action and plain environment values', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const sandbox = await makeTempDir('postman-resolve-service-token-precedence-');
    const result = await execFileAsync(
      process.execPath,
      [
        cliPath,
        '--postman-access-token',
        'flag-access-token',
        '--postman-team-id',
        'flag-team-id'
      ],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: sandbox,
          TMPDIR: sandbox,
          INPUT_POSTMAN_ACCESS_TOKEN: 'input-access-token',
          INPUT_POSTMAN_TEAM_ID: 'input-team-id',
          POSTMAN_ACCESS_TOKEN: 'plain-access-token',
          POSTMAN_ACTIONS_TELEMETRY: 'off'
        },
        maxBuffer: 1024 * 1024
      }
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      token: 'flag-access-token',
      'team-id': 'flag-team-id',
      skipped: 'true'
    });
  });

  it('packs, prepares, and runs postman-resolve-service-token --help/--version without side effects', async () => {
    const packDir = await makeTempDir('postman-resolve-service-token-pack-');
    const prefixDir = await makeTempDir('postman-resolve-service-token-prefix-');
    const binSandbox = await makeTempDir('postman-resolve-service-token-bin-sandbox-');
    const distBefore = new Map(
      await Promise.all(
        ['cli.cjs', 'index.cjs'].map(async (name) => [name, await readFile(path.join(repoRoot, 'dist', name))] as const)
      )
    );

    const packResult = await execFileAsync(
      npmCommand,
      [...npmCliArgs, 'pack', '--json', '--pack-destination', packDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
          NPM_CONFIG_IGNORE_SCRIPTS: 'true',
          PATH: process.env.PATH ?? ''
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );
    const [packed] = JSON.parse(packResult.stdout) as Array<{
      filename: string;
      name: string;
      files: Array<{ mode: number; path: string }>;
    }>;
    expect(packed.name).toBe('@postman/onboarding-resolve-service-token');
    expect(
      packed.files.filter((file) => file.path.startsWith('dist/')).map((file) => file.path).sort()
    ).toEqual(['dist/cli.cjs', 'dist/index.cjs']);
    if (process.platform !== 'win32') {
      expect(packed.files.find((file) => file.path === 'dist/cli.cjs')?.mode).toBe(0o755);
    }

    const tarballPath = path.join(packDir, packed.filename);
    const packedManifestResult = await execFileAsync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    const packedPackageJson = JSON.parse(packedManifestResult.stdout) as {
      name: string;
      version: string;
      bin: string | Record<string, string>;
    };
    const packedBinEntries =
      typeof packedPackageJson.bin === 'string'
        ? [[packedPackageJson.name.replace(/^@[^/]+\//, ''), packedPackageJson.bin] as const]
        : Object.entries(packedPackageJson.bin);
    expect(packedBinEntries).toHaveLength(1);
    const [[packedBinName, packedBinRelativePath]] = packedBinEntries;
    const binName = packedBinName;

    const planSetup = (platform: NodeJS.Platform): { file: string; args: string[] } =>
      platform === 'win32'
        ? { file: 'tar', args: ['-xzf', tarballPath, '-C', prefixDir] }
        : {
            file: npmCommand,
            args: [...npmCliArgs, 'install', '--prefix', prefixDir, '--ignore-scripts', tarballPath]
          };

    // Linux-safe regression check: the Windows setup plan extracts only and never runs an npm dependency install.
    const windowsSetupPlan = planSetup('win32');
    expect(windowsSetupPlan.file).toBe('tar');
    expect(windowsSetupPlan.args).not.toContain('install');

    await mkdir(prefixDir, { recursive: true });
    const setupPlan = planSetup(process.platform);
    await execFileAsync(setupPlan.file, setupPlan.args, {
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });

    const packedBinDir = path.join(prefixDir, 'node_modules', '.bin');
    const packedBinPath = path.join(
      packedBinDir,
      process.platform === 'win32' ? `${binName}.cmd` : binName
    );
    if (process.platform === 'win32') {
      const packedCliPath = path.resolve(prefixDir, 'package', packedBinRelativePath);
      await mkdir(packedBinDir, { recursive: true });
      await writeFile(packedBinPath, `@ECHO off\r\n"${process.execPath}" "${packedCliPath}" %*\r\n`, 'utf8');
    }

    // Prove the planned executable is ComSpec rather than the .cmd shim on Windows (Linux-safe structural check).
    const plannedHelp = planPackedBinInvocation(packedBinPath, ['--help']);
    expect(plannedHelp.file.toLowerCase()).not.toMatch(/\.cmd$/);

    const help = await runPackedBin(packedBinPath, ['--help'], {
      cwd: binSandbox,
      env: {
        PATH: process.env.PATH ?? '',
        INPUT_POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_ACCESS_TOKEN: 'should-not-be-used',
        HOME: binSandbox,
        TMPDIR: binSandbox
      }
    });

    expect(help.stdout).toMatch(/Usage:\s+postman-resolve-service-token/i);
    expect(help.stderr).not.toMatch(
      /permission denied|exec format|syntax error|unexpected token|"use strict"/i
    );
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await runPackedBin(packedBinPath, ['--version'], {
      cwd: binSandbox,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: binSandbox,
        TMPDIR: binSandbox
      }
    });
    expect(version.stdout.trim()).toBe(packedPackageJson.version);
    await assertSandboxUnchanged(binSandbox);

    for (const [name, before] of distBefore) {
      expect(await readFile(path.join(repoRoot, 'dist', name))).toEqual(before);
    }
  }, 60_000);

  it('keeps an exact on-disk dist census of cli/index entrypoints', async () => {
    const distDir = path.join(repoRoot, 'dist');
    const onDisk = await readdir(distDir);
    expect(onDisk.slice().sort()).toEqual(['cli.cjs', 'index.cjs']);
  });

  it('does not rebuild dist from packaging tests', async () => {
    const packageJson = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
    const packagingSource = await readFile(path.join(repoRoot, 'tests', 'cli-packaging.test.ts'), 'utf8');
    // Build the banned rebuild token without embedding the contiguous literal in this file,
    // otherwise the self-scan would match the expectation source itself.
    const bannedRebuild = ['rm', '-rf', 'dist'].join(' ');
    expect(scripts['verify:dist:assert']).toBeUndefined();
    expect(scripts['verify:dist']).toBeUndefined();
    expect(scripts['verify:bundle']).toBe(
      ['npm run', 'bundle', '&& node scripts/verify-dist-artifact.mjs'].join(' ')
    );
    expect(packageJson).toMatch(/"bundle"/);
    expect(packagingSource).not.toMatch(/\bnpm run (?:build|bundle)\b/);
    expect(packagingSource).not.toMatch(/\besbuild\b/);
    expect(packagingSource).not.toMatch(new RegExp(bannedRebuild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(packagingSource).not.toMatch(/\bshell:\s*true\b/);
  });
});
