import { beforeEach, describe, expect, test } from 'vitest';

import { runResolveServiceToken, type ResolveDependencies } from '../src/index.js';
import { __resetPmakDiagnosticMemo, inspectPmakIdentity } from '../src/pmak-diagnostics.js';

function expectNoTerminalControls(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isControl = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    expect(isControl, `unexpected control U+${code.toString(16)} at ${i}`).toBe(false);
  }
}

function createCore() {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  const infos: string[] = [];

  return {
    outputs,
    secrets,
    infos,
    core: {
      info(message: string) {
        infos.push(message);
      },
      setOutput(name: string, value: string) {
        outputs[name] = value;
      },
      setSecret(value: string) {
        secrets.push(value);
      }
    }
  };
}

beforeEach(() => {
  __resetPmakDiagnosticMemo();
});

describe('mint failure error messages', () => {
  test.each([
    [
      'personal PMAK',
      401,
      { user: { username: 'jane-doe', email: 'jane@example.com' } },
      'Personal API key detected, cannot mint a service-account access token'
    ],
    [
      'service-account PMAK without mint permission',
      403,
      { user: { username: null, email: '' } },
      'postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens'
    ],
    [
      'invalid PMAK',
      401,
      undefined,
      'postman-api-key is invalid, disabled, or expired'
    ]
  ])('classifies %s after rejected mint without leaking identity or PMAK', async (_name, mintStatus, meBody, expected) => {
    const harness = createCore();
    const pmak = 'PMAK-diagnostic-secret';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/service-account-tokens')) return new Response('{}', { status: mintStatus });
        if (String(url).endsWith('/me')) {
          return new Response(meBody ? JSON.stringify(meBody) : '{}', { status: meBody ? 200 : 401 });
        }
        throw new Error('unexpected fetch');
      },
    };

    await expect(runResolveServiceToken({
      postmanApiKey: pmak,
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies)).rejects.toThrow(expected);

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.getpostman.com/service-account-tokens',
      'https://api.getpostman.com/me'
    ]);
    expect(calls[1]?.init?.headers).toEqual({ 'x-api-key': pmak });
  });

  test('returns the masked original mint failure when diagnosis is inconclusive', async () => {
    const harness = createCore();
    const pmak = 'PMAK-sentinel';
    let meCalls = 0;
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) return new Response('{}', { status: 401 });
        meCalls += 1;
        throw new Error(`transport ${pmak}\r\nPMAK rejected, HTTP 401`);
      },
    };

    let message = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(meCalls).toBe(1);
    expect(message).toBe('POST https://api.getpostman.com/service-account-tokens (mint service-account token): The postman-api-key was rejected (HTTP 401); confirm it is a valid, enabled PMAK for the intended team.');
    expect(message).not.toContain(pmak);
    expectNoTerminalControls(message);
  });

  test('memoizes concurrent diagnostics by normalized API host and PMAK', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify({ user: { username: null, email: null } }), { status: 200 });
    };

    const results = await Promise.all([
      inspectPmakIdentity({ apiBaseUrl: 'https://api.getpostman.com/', apiKey: 'pmak-cache', fetchImpl: fetcher }),
      inspectPmakIdentity({ apiBaseUrl: 'https://api.getpostman.com', apiKey: 'pmak-cache', fetchImpl: fetcher }),
      inspectPmakIdentity({ apiBaseUrl: 'https://api.getpostman.com/', apiKey: 'pmak-cache', fetchImpl: fetcher })
    ]);

    expect(calls).toBe(1);
    expect(results.map((result) => result.kind)).toEqual(['service-account', 'service-account', 'service-account']);
  });
  test('mint failure on 403 yields actionable PMAK message', async () => {
    const harness = createCore();
    const pmak = 'pmak-403-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response('{"error":"Forbidden"}', { status: 403 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('The postman-api-key was rejected (HTTP 403)');
    expect(errorMessage).toMatch(/confirm it is a valid, enabled PMAK/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(pmak);
  });

  test('mint failure on 401 yields actionable PMAK message', async () => {
    const harness = createCore();
    const pmak = 'pmak-401-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response('{"error":"Unauthorized"}', { status: 401 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('The postman-api-key was rejected (HTTP 401)');
    expect(errorMessage).toMatch(/confirm it is a valid, enabled PMAK/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(pmak);
  });

  test('mint failure on 400 service-accounts-disabled yields enablement message', async () => {
    const harness = createCore();
    const pmak = 'pmak-DISABLED-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response('{"error":"service accounts not enabled for this team"}', { status: 400 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('Service accounts are not enabled for this team');
    expect(errorMessage).toContain('targeted by postman-api-key');
    expect(errorMessage).toContain('Team Settings');
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(pmak);
  });

  test('mint failure on 400 without service-accounts keyword keeps generic error', async () => {
    const harness = createCore();
    const pmak = 'pmak-SECRET-SENTINEL-VALUE';
    const uniqueTail = 'UNIQUE-TAIL-SHOULD-NOT-APPEAR-IN-BOUNDED-DETAIL';
    const ansiPrefix = '\u001b[31mALERT\u001b[0m\u0007\u009b';
    const overLimitBody = `{"error":"${ansiPrefix} leak ${pmak} ${'x'.repeat(220)} ${uniqueTail}"}`;
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(`${overLimitBody}\nextra\nlines`, { status: 400 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('HTTP 400');
    expect(errorMessage).toContain('ALERT');
    expect(errorMessage).toMatch(/Verify the postman-api-key|retry|contact Postman support/);
    expect(errorMessage).toContain('...');
    expect(errorMessage).not.toContain(uniqueTail);
    expectNoTerminalControls(errorMessage);
    expect(errorMessage).not.toContain(pmak);
    expect(errorMessage).toContain('[REDACTED]');
  });

  test('mint response-body read failure names endpoint, cause, and remediation', async () => {
    const harness = createCore();
    const pmak = 'pmak-BODY-READ-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return {
            ok: true,
            status: 201,
            async text() {
              throw new Error(`stream destroyed with ${pmak}`);
            }
          } as unknown as Response;
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('failed to read response body');
    expect(errorMessage).toContain('stream destroyed');
    expect(errorMessage).toMatch(/Verify the postman-api-key|retry|contact Postman support/);
    expect(errorMessage).not.toContain('no access token');
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(pmak);
  });

  test('mint transport failure names endpoint and remediation', async () => {
    const harness = createCore();
    const pmak = 'pmak-TRANSPORT-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async () => {
        throw new Error(`connect ECONNREFUSED with ${pmak}`);
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: pmak,
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('mint service-account token');
    expect(errorMessage).toContain('ECONNREFUSED');
    expect(errorMessage).toMatch(/Verify the postman-api-key|retry|contact Postman support/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(pmak);
  });

  test('mint malformed JSON names endpoint and remediation', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response('not-json{', { status: 201 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('malformed JSON');
    expect(errorMessage).toMatch(/Verify the postman-api-key|retry|contact Postman support/);
    expect(errorMessage).not.toContain('\n');
  });

  test('mint success without token names endpoint and remediation', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ ok: true }), { status: 201 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(errorMessage).toContain('no access token');
    expect(errorMessage).toMatch(/Verify the postman-api-key|retry|contact Postman support/);
    expect(errorMessage).not.toContain('\n');
  });
});

describe('/me failure error messages', () => {
  test('/me HTTP failure names endpoint, status, and remediation', async () => {
    const harness = createCore();
    const token = 'minted-token-SECRET-VALUE';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return new Response(`{"error":"boom with ${token}"}\nline2`, { status: 500 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('GET https://api.getpostman.com/me');
    expect(errorMessage).toContain('resolve team identity');
    expect(errorMessage).toContain('HTTP 500');
    expect(errorMessage).toMatch(/Verify the access token|postman-team-id/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(token);
    expect(errorMessage).toContain('[REDACTED]');
  });

  test('/me transport failure names endpoint, cause, and remediation', async () => {
    const harness = createCore();
    const token = 'minted-token-TRANSPORT-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          throw new Error(`getaddrinfo ENOTFOUND with ${token}`);
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('GET https://api.getpostman.com/me');
    expect(errorMessage).toContain('resolve team identity');
    expect(errorMessage).toContain('ENOTFOUND');
    expect(errorMessage).toMatch(/Verify the access token|postman-team-id/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(token);
  });

  test('/me malformed JSON names endpoint and remediation', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: 'minted-token-fake' } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return new Response('not-json{', { status: 200 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('GET https://api.getpostman.com/me');
    expect(errorMessage).toContain('malformed JSON');
    expect(errorMessage).toMatch(/Verify the access token|postman-team-id/);
    expect(errorMessage).not.toContain('\n');
  });

  test('/me response-body read failure names endpoint, cause, and remediation', async () => {
    const harness = createCore();
    const token = 'minted-token-ME-BODY-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return {
            ok: true,
            status: 200,
            async text() {
              throw new Error(`me body unread with ${token}`);
            }
          } as unknown as Response;
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('GET https://api.getpostman.com/me');
    expect(errorMessage).toContain('resolve team identity');
    expect(errorMessage).toContain('failed to read response body');
    expect(errorMessage).toContain('me body unread');
    expect(errorMessage).toMatch(/Verify the access token|postman-team-id/);
    expect(errorMessage).not.toContain('did not include a team id');
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(token);
  });

  test('/me missing team id names endpoint and remediation', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: 'minted-token-fake' } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 200 });
        }
        throw new Error('unexpected fetch');
      },
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('GET https://api.getpostman.com/me');
    expect(errorMessage).toContain('did not include a team id');
    expect(errorMessage).toMatch(/Verify the access token|postman-team-id/);
    expect(errorMessage).not.toContain('\n');
  });
});

describe('identity echo after successful mint', () => {
  test('mint echoes resolved identity (team id, user) after minting', async () => {
    const harness = createCore();
    const rawTeamId = 'team-789\r\nextra\u001b[32m';
    const rawUserId = 'user-42\nline\u0007';
    const rawFullName = 'Test\rUser\u009b';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: 'minted-token-fake' } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return new Response(JSON.stringify({
            user: {
              teamId: rawTeamId,
              id: rawUserId,
              fullName: rawFullName
            }
          }), { status: 200 });
        }
        throw new Error('unexpected fetch');
      },
    };

    const result = await runResolveServiceToken({
      postmanApiKey: 'pmak-test-fake',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    expect(result.teamId).toBe(rawTeamId);
    expect(harness.outputs['team-id']).toBe(rawTeamId);

    const echoLine = harness.infos.find((line) => line.startsWith('resolve-service-token:'));
    expect(echoLine).toBeDefined();
    expect(echoLine).toContain('team-789 extra');
    expect(echoLine).toContain('user-42 line');
    expect(echoLine).toContain('Test User');
    expectNoTerminalControls(echoLine!);
  });

  test('echo line carries no token (masking-safe by construction)', async () => {
    const harness = createCore();
    const mintedToken = 'minted-token-secret-fake';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: mintedToken } }), { status: 201 });
        }
        if (String(url).endsWith('/me')) {
          return new Response(JSON.stringify({
            user: {
              teamId: 'team-999',
              id: 'user-77',
              fullName: 'Sample Name'
            }
          }), { status: 200 });
        }
        throw new Error('unexpected fetch');
      },
    };

    await runResolveServiceToken({
      postmanApiKey: 'pmak-test-fake',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    const echoLine = harness.infos.find((line) => line.startsWith('resolve-service-token:'));
    expect(echoLine).toBeDefined();
    expect(echoLine).toContain('team-999');
    expect(echoLine).toContain('user-77');

    // Token must not appear in the echo
    expect(echoLine).not.toContain(mintedToken);

    // Style-ban: no dangerous credential prefixes, no em dash, no antithesis shapes
    const allInfos = harness.infos.join('\n');
    expect(allInfos).not.toContain('Bearer ');
    expect(allInfos).not.toContain('x-access-token:');
    expect(allInfos).not.toContain('\u2014'); 
    expect(allInfos).not.toContain(' , not ');
    expect(allInfos).not.toContain(' - not ');
  });
});

describe('style-ban on mint failure messages', () => {
  test('403 mint failure message passes style-ban', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async () => new Response('{}', { status: 403 }),
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).not.toContain('Bearer ');
    expect(errorMessage).not.toContain('x-access-token:');
    expect(errorMessage).not.toContain('\u2014');
    expect(errorMessage).not.toContain(' , not ');
    expect(errorMessage).not.toContain(' - not ');
  });

  test('400 service-accounts-disabled message passes style-ban', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async () => new Response('service accounts not enabled', { status: 400 }),
    };

    let errorMessage = '';
    try {
      await runResolveServiceToken({
        postmanApiKey: 'pmak-test-fake',
        postmanStack: 'prod',
        writeGithubSecret: false,
        accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
        teamIdSecretName: 'POSTMAN_TEAM_ID'
      }, dependencies);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).not.toContain('Bearer ');
    expect(errorMessage).not.toContain('x-access-token:');
    expect(errorMessage).not.toContain('\u2014');
    expect(errorMessage).not.toContain(' , not ');
    expect(errorMessage).not.toContain(' - not ');
  });
});
