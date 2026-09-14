import { describe, expect, test } from 'vitest';

import { runResolveServiceToken, type ResolveDependencies } from '../src/index.js';

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
  const warnings: string[] = [];

  return {
    outputs,
    secrets,
    infos,
    warnings,
    core: {
      info(message: string) {
        infos.push(message);
      },
      warning(message: string) {
        warnings.push(message);
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

interface HttpReceipt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function createHttpReceipt(url: string | URL, init?: RequestInit): HttpReceipt {
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    ...(body === undefined ? {} : { body })
  };
}

function parseSecretBody(receipt: HttpReceipt): { encrypted_value: string; key_id: string } {
  const parsed: unknown = JSON.parse(receipt.body ?? '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object request body');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.encrypted_value !== 'string' || typeof record.key_id !== 'string') {
    throw new Error('Expected encrypted_value and key_id strings');
  }
  expect(Object.keys(record).sort()).toEqual(['encrypted_value', 'key_id']);
  return { encrypted_value: record.encrypted_value, key_id: record.key_id };
}

async function captureError(promise: Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught instanceof Error ? caught.message : String(caught);
}

describe('runResolveServiceToken', () => {
  test('passes through an existing token and team ID with write=false and makes no Postman or GitHub calls', async () => {
    const harness = createCore();
    const rawTeamId = 'team-123\r\nextra';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      env: {
        GITHUB_REPOSITORY: 'postman-cs/example',
        GITHUB_API_URL: 'https://github.example/api/v3',
        UNRELATED_CREDENTIAL: 'must-not-be-exposed'
      },
      fetcher: async () => {
        throw new Error('fetch should not be called');
      }
    };

    const result = await runResolveServiceToken({
      postmanAccessToken: 'existing-token',
      postmanTeamId: rawTeamId,
      postmanRegion: 'us',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    expect(result).toEqual({
      token: 'existing-token',
      teamId: rawTeamId,
      skipped: true
    });
    expect(harness.outputs).toMatchObject({
      token: 'existing-token',
      'team-id': rawTeamId,
      skipped: 'true'
    });
    expect(harness.secrets).toEqual(['existing-token']);
    expect(harness.warnings).toEqual([
      'Using a provided postman-access-token. Prefer minting a fresh service-account token with postman-api-key unless this workflow intentionally manages token rotation outside this action.'
    ]);
    const providedTeamInfo = harness.infos.find((line) => line.startsWith('Using provided postman-team-id'));
    expect(providedTeamInfo).toBe('Using provided postman-team-id team-123 extra.');
    expect(providedTeamInfo).not.toContain('\n');
    expect(providedTeamInfo).not.toContain('\r');
  });

  test('mints a token and resolves team ID from prod APIs', async () => {
    const harness = createCore();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: 'minted-token' } }), { status: 201 });
        }
        return new Response(JSON.stringify({ user: { teamId: 'team-456' } }), { status: 200 });
      }
    };

    const result = await runResolveServiceToken({
      postmanApiKey: 'pmak-service',
      postmanRegion: 'us',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    expect(result).toEqual({
      token: 'minted-token',
      teamId: 'team-456',
      skipped: false
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.getpostman.com/service-account-tokens',
      'https://api.getpostman.com/me'
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-api-key': 'pmak-service'
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ apiKey: 'pmak-service' });
    expect(calls[1]?.init?.headers).toMatchObject({
      Authorization: 'Bearer minted-token',
      'x-api-key': 'pmak-service'
    });
    expect(harness.outputs).toMatchObject({
      token: 'minted-token',
      'team-id': 'team-456',
      skipped: 'false'
    });
    expect(harness.secrets).toEqual(['minted-token']);
  });

  test('resolves team ID from the nested team-object /me shape', async () => {
    const harness = createCore();
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ access_token: 'minted-token' }), { status: 201 });
        }
        return new Response(JSON.stringify({ team: { id: 'team-789' } }), { status: 200 });
      }
    };

    const result = await runResolveServiceToken({
      postmanApiKey: 'pmak-service',
      postmanRegion: 'us',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    expect(result).toEqual({
      token: 'minted-token',
      teamId: 'team-789',
      skipped: false
    });
    expect(harness.outputs).toMatchObject({ 'team-id': 'team-789' });
  });

  test.each([
    ['the default GitHub API URL', undefined, 'https://api.github.com'],
    ['a custom GITHUB_API_URL', 'https://github.example/api/v3/', 'https://github.example/api/v3']
  ])('uses REST sealed-box persistence with %s', async (_label, githubApiUrl, expectedApiUrl) => {
    const harness = createCore();
    const receipts: HttpReceipt[] = [];
    const githubToken = 'ghp-REST-SECRET';
    const accessToken = 'existing-token-REST';
    const teamId = 'team-REST';
    const publicKey = Buffer.alloc(32, 7).toString('base64');
    const dependencies: ResolveDependencies = {
      core: harness.core,
      env: {
        GITHUB_REPOSITORY: 'postman-cs/example',
        ...(githubApiUrl ? { GITHUB_API_URL: githubApiUrl } : {}),
        UNRELATED_CREDENTIAL: 'unrelated-env-secret'
      },
      fetcher: async (url, init) => {
        receipts.push(createHttpReceipt(url, init));
        if (receipts.length === 1) {
          return new Response(JSON.stringify({ key_id: 'key-id-123', key: publicKey }), { status: 200 });
        }
        return receipts.length === 2
          ? new Response('', { status: 201 })
          : new Response(null, { status: 204 });
      }
    };

    await runResolveServiceToken({
      postmanAccessToken: accessToken,
      postmanTeamId: teamId,
      postmanRegion: 'us',
      postmanStack: 'prod',
      writeGithubSecret: true,
      githubToken,
      accessTokenSecretName: 'CUSTOM_TOKEN',
      teamIdSecretName: 'CUSTOM_TEAM'
    }, dependencies);

    expect(receipts.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: `${expectedApiUrl}/repos/postman-cs/example/actions/secrets/public-key` },
      { method: 'PUT', url: `${expectedApiUrl}/repos/postman-cs/example/actions/secrets/CUSTOM_TOKEN` },
      { method: 'PUT', url: `${expectedApiUrl}/repos/postman-cs/example/actions/secrets/CUSTOM_TEAM` }
    ]);
    expect(receipts[0]?.headers).toEqual({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28'
    });
    expect(receipts[0]?.body).toBeUndefined();
    for (const receipt of receipts.slice(1)) {
      expect(receipt.headers).toEqual({
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${githubToken}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28'
      });
    }

    const accessBody = parseSecretBody(receipts[1] ?? { url: '', method: '', headers: {} });
    const teamBody = parseSecretBody(receipts[2] ?? { url: '', method: '', headers: {} });
    expect(accessBody.key_id).toBe('key-id-123');
    expect(teamBody.key_id).toBe('key-id-123');
    for (const [body, plaintext] of [[accessBody, accessToken], [teamBody, teamId]] as const) {
      expect(body.encrypted_value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(body.encrypted_value).not.toBe(plaintext);
      expect(Buffer.from(body.encrypted_value, 'base64').length).toBeGreaterThan(Buffer.byteLength(plaintext));
      expect(Buffer.from(body.encrypted_value, 'base64').toString('utf8')).not.toContain(plaintext);
    }
    const serializedReceipts = JSON.stringify(receipts);
    expect(serializedReceipts).not.toContain(accessToken);
    expect(serializedReceipts).not.toContain(teamId);
    expect(serializedReceipts).not.toContain('unrelated-env-secret');
    expect(harness.infos).toContain('Wrote secrets: CUSTOM_TOKEN, CUSTOM_TEAM');
  });

  test.each([
    ['leading-dash', '-TOKEN'],
    ['env-file-shaped', '--env-file=/tmp/secrets'],
    ['reserved', 'github_custom'],
    ['numeric-leading', '1TOKEN']
  ])('rejects %s secret names in both inputs before Postman or GitHub calls', async (_label, invalidName) => {
    for (const field of ['accessTokenSecretName', 'teamIdSecretName'] as const) {
      const harness = createCore();
      let fetchCalls = 0;
      const inputs = {
        postmanApiKey: 'pmak-must-not-be-used',
        postmanRegion: 'us',
        postmanStack: 'prod',
        writeGithubSecret: true,
        githubToken: 'ghp-must-not-be-used',
        accessTokenSecretName: 'CUSTOM_TOKEN',
        teamIdSecretName: 'CUSTOM_TEAM',
        [field]: invalidName
      };
      const message = await captureError(runResolveServiceToken(inputs, {
        core: harness.core,
        env: { GITHUB_REPOSITORY: 'postman-cs/example' },
        fetcher: async () => {
          fetchCalls += 1;
          throw new Error('network should not be called');
        }
      }));

      expect(message).toContain(field === 'accessTokenSecretName'
        ? 'access-token-secret-name'
        : 'team-id-secret-name');
      expect(fetchCalls).toBe(0);
      expect(harness.outputs).toEqual({});
    }
  });

  test.each(['owner', '/repo', 'owner/', 'owner/repo/extra', ' owner/repo'])(
    'rejects malformed GITHUB_REPOSITORY %j before a GitHub call',
    async (repository) => {
      const harness = createCore();
      let fetchCalls = 0;
      const message = await captureError(runResolveServiceToken({
        postmanAccessToken: 'existing-token',
        postmanTeamId: 'team-123',
        writeGithubSecret: true,
        githubToken: 'ghp-must-not-be-used',
        accessTokenSecretName: 'CUSTOM_TOKEN',
        teamIdSecretName: 'CUSTOM_TEAM'
      }, {
        core: harness.core,
        env: { GITHUB_REPOSITORY: repository },
        fetcher: async () => {
          fetchCalls += 1;
          throw new Error('network should not be called');
        }
      }));

      expect(message).toContain('GITHUB_REPOSITORY');
      expect(fetchCalls).toBe(0);
    }
  );

  test('redacts credentials from a first GitHub secret PUT failure', async () => {
    const harness = createCore();
    const receipts: HttpReceipt[] = [];
    const githubToken = 'ghp-FIRST-WRITE-SECRET';
    const accessToken = 'existing-token-FIRST';
    const postmanApiKey = 'pmak-FIRST-WRITE-SECRET';
    const dependencies: ResolveDependencies = {
      core: harness.core,
      env: { GITHUB_REPOSITORY: 'postman-cs/example' },
      fetcher: async (url, init) => {
        receipts.push(createHttpReceipt(url, init));
        if (receipts.length === 1) {
          return new Response(JSON.stringify({
            key_id: 'key-id-123',
            key: Buffer.alloc(32, 11).toString('base64')
          }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ message: `denied ${githubToken} ${accessToken} ${postmanApiKey}\nsecond line` }),
          { status: 403 }
        );
      }
    };

    const errorMessage = await captureError(runResolveServiceToken({
      postmanApiKey,
      postmanAccessToken: accessToken,
      postmanTeamId: 'team-123',
      writeGithubSecret: true,
      githubToken,
      accessTokenSecretName: 'CUSTOM_TOKEN',
      teamIdSecretName: 'CUSTOM_TEAM'
    }, dependencies));

    expect(receipts.map(({ method }) => method)).toEqual(['GET', 'PUT']);
    expect(errorMessage).toContain('Failed to write GitHub secret CUSTOM_TOKEN');
    expect(errorMessage).toContain('postman-cs/example');
    expect(errorMessage).toContain('HTTP 403');
    expect(errorMessage).toMatch(/secrets-write/);
    expect(errorMessage).not.toContain('Partial success');
    expectNoTerminalControls(errorMessage);
    expect(errorMessage).not.toContain(githubToken);
    expect(errorMessage).not.toContain(accessToken);
    expect(errorMessage).not.toContain(postmanApiKey);
  });

  test('second REST secret PUT failure reports access-token-first partial success without leaking plaintext', async () => {
    const harness = createCore();
    const ghToken = 'ghp-SECOND-WRITE-SECRET';
    const accessToken = 'existing-token-SECOND';
    const receipts: HttpReceipt[] = [];
    const dependencies: ResolveDependencies = {
      core: harness.core,
      env: { GITHUB_REPOSITORY: 'postman-cs/example' },
      fetcher: async (url, init) => {
        receipts.push(createHttpReceipt(url, init));
        if (receipts.length === 1) {
          return new Response(JSON.stringify({
            key_id: 'key-id-123',
            key: Buffer.alloc(32, 13).toString('base64')
          }), { status: 200 });
        }
        if (receipts.length === 2) return new Response('', { status: 201 });
        return new Response(
          JSON.stringify({ message: `denied ${ghToken} ${accessToken}\nsecond line` }),
          { status: 403 }
        );
      }
    };

    const errorMessage = await captureError(runResolveServiceToken({
      postmanAccessToken: accessToken,
      postmanTeamId: 'team-123',
      writeGithubSecret: true,
      githubToken: ghToken,
      accessTokenSecretName: 'CUSTOM_TOKEN',
      teamIdSecretName: 'CUSTOM_TEAM'
    }, dependencies));

    expect(receipts.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: 'https://api.github.com/repos/postman-cs/example/actions/secrets/public-key' },
      { method: 'PUT', url: 'https://api.github.com/repos/postman-cs/example/actions/secrets/CUSTOM_TOKEN' },
      { method: 'PUT', url: 'https://api.github.com/repos/postman-cs/example/actions/secrets/CUSTOM_TEAM' }
    ]);
    expect(errorMessage).toContain('Partial success');
    expect(errorMessage).toContain('CUSTOM_TOKEN');
    expect(errorMessage).toContain('CUSTOM_TEAM');
    expect(errorMessage).toContain('postman-cs/example');
    expect(errorMessage).toContain('HTTP 403');
    expect(errorMessage).toMatch(/secrets-write|reconcile|rotate/);
    expect(errorMessage).not.toContain('\n');
    expect(errorMessage).not.toContain(ghToken);
    expect(errorMessage).not.toContain(accessToken);
  });

  test('requires a Postman API key when no token is provided', async () => {
    const harness = createCore();

    await expect(runResolveServiceToken({
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, {
      core: harness.core,
      fetcher: fetch
    })).rejects.toThrow('postman-api-key is required when postman-access-token is not provided.');
  });

  test('uses the EU Postman API host when postman-region is eu', async () => {
    const harness = createCore();
    const calls: string[] = [];
    const dependencies: ResolveDependencies = {
      core: harness.core,
      fetcher: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/service-account-tokens')) {
          return new Response(JSON.stringify({ session: { token: 'minted-token' } }), { status: 201 });
        }
        return new Response(JSON.stringify({ user: { teamId: 'team-eu' } }), { status: 200 });
      }
    };

    await runResolveServiceToken({
      postmanApiKey: 'pmak-service',
      postmanRegion: 'eu',
      postmanStack: 'prod',
      writeGithubSecret: false,
      accessTokenSecretName: 'POSTMAN_ACCESS_TOKEN',
      teamIdSecretName: 'POSTMAN_TEAM_ID'
    }, dependencies);

    expect(calls).toEqual([
      'https://api.eu.postman.com/service-account-tokens',
      'https://api.eu.postman.com/me'
    ]);
  });
});
