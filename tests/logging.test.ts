import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '@postman-cs/automation-core';

import { coreLogSink, runResolveServiceToken, type CoreLike, type ResolveInputs } from '../src/index.js';

/**
 * A log line is evidence. These tests pin the three properties that make it
 * worth trusting: credentials never survive into it, a failure names the phase
 * it died in, and one HTTP exchange is identifiable from its fields alone.
 */

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push(`debug ${message}`),
      info: (message) => lines.push(`info ${message}`),
      warning: (message) => lines.push(`warning ${message}`),
      error: (message) => lines.push(`error ${message}`)
    }
  };
}

function stubCore(): CoreLike & { outputs: Record<string, string>; secrets: string[] } {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  return {
    outputs,
    secrets,
    info: () => {},
    warning: () => {},
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setSecret: (value) => {
      secrets.push(value);
    }
  };
}

const PMAK = 'PMAK-testkeyvalue-0123456789';
const MINTED = 'minted-access-token-abcdef';

function baseInputs(overrides: Partial<ResolveInputs> = {}): ResolveInputs {
  return {
    postmanApiKey: PMAK,
    postmanRegion: 'us',
    postmanStack: 'prod',
    writeGithubSecret: false,
    accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
    teamIdSecretName: 'POSTMAN_TEAM_ID',
    ...overrides
  };
}

function jsonResponse(body: unknown, init: { status?: number; requestId?: string } = {}): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name === 'x-request-id' ? (init.requestId ?? null) : null) },
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

describe('resolve-service-token logging', () => {
  it('never emits a credential, including the token it just minted', async () => {
    const { sink, lines } = recordingSink();
    const logger = createLogger({ sink, level: 'debug' });
    const core = stubCore();
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('service-account-tokens')) {
        return jsonResponse({ session: { token: MINTED } });
      }
      // Echo the bearer token back in the body: an upstream that reflects the
      // credential must not turn a diagnostic line into a leak.
      return jsonResponse({ user: { teamId: '10490519', id: '42', fullName: `svc ${MINTED}` } });
    });

    await runResolveServiceToken(baseInputs(), {
      core,
      fetcher: fetcher as never,
      execFile: async () => ({ stdout: '', stderr: '' }),
      env: {},
      logger
    });

    const all = lines.join('\n');
    expect(all).not.toContain(PMAK);
    expect(all).not.toContain(MINTED);
    expect(core.secrets).toContain(MINTED);
  });

  it('names the phase that failed and the exchange that failed it', async () => {
    const { sink, lines } = recordingSink();
    const logger = createLogger({ sink, level: 'debug' });
    const fetcher = vi.fn(async () =>
      jsonResponse({ message: 'nope' }, { status: 401, requestId: 'req-7' })
    );

    await expect(
      runResolveServiceToken(baseInputs(), {
        core: stubCore(),
        fetcher: fetcher as never,
        execFile: async () => ({ stdout: '', stderr: '' }),
        env: {},
        logger
      })
    ).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('phase=mint-service-token');
    expect(all).toContain('status=401');
    expect(all).toContain('request_id=req-7');
    expect(all).toContain('method=POST');
    // The URL is kept so "wrong host" stays distinguishable from "wrong route".
    expect(all).toContain('service-account-tokens');
  });

  it('carries the transport failure cause chain when no status was ever returned', async () => {
    const { sink, lines } = recordingSink();
    const logger = createLogger({ sink, level: 'debug' });
    const fetcher = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED', { cause: new Error('getaddrinfo failed') });
    });

    await expect(
      runResolveServiceToken(baseInputs(), {
        core: stubCore(),
        fetcher: fetcher as never,
        execFile: async () => ({ stdout: '', stderr: '' }),
        env: {},
        logger
      })
    ).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('connect ECONNREFUSED');
    expect(all).toContain('caused by');
    expect(all).toContain('getaddrinfo failed');
  });

  it('stays quiet at default level and opens up under RUNNER_DEBUG', async () => {
    async function run(env: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      const core = stubCore();
      const fetcher = vi.fn(async (url: string) =>
        String(url).includes('service-account-tokens')
          ? jsonResponse({ session: { token: MINTED } })
          : jsonResponse({ user: { teamId: '10490519' } })
      );
      await runResolveServiceToken(baseInputs(), {
        core,
        fetcher: fetcher as never,
        execFile: async () => ({ stdout: '', stderr: '' }),
        env,
        logger: createLogger({ sink, env })
      });
      return lines;
    }

    // Default: no debug chatter in an ordinary consumer's log.
    expect((await run({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    // GitHub's "Re-run with debug logging" raises verbosity with no new release.
    expect(
      (await run({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
  });

  it('routes sink levels through the host facade, dropping debug when it has no debug channel', () => {
    const calls: string[] = [];
    // A CoreLike with neither debug nor error: warning must absorb error, and
    // debug must be dropped rather than promoted into the default log.
    const minimal: CoreLike = {
      info: (message) => calls.push(`info:${message}`),
      warning: (message) => calls.push(`warning:${message}`),
      setOutput: () => {},
      setSecret: () => {}
    };
    const sink = coreLogSink(minimal);
    sink.debug('d');
    sink.info('i');
    sink.warning('w');
    sink.error('e');
    expect(calls).toEqual(['info:i', 'warning:w', 'warning:e']);
  });
});
