import { spawn } from 'node:child_process';

import {
  createLogger,
  createTelemetryContext,
  httpFields,
  type LogSink,
  type Logger
} from '@postman-cs/automation-core';
import { resolveActionVersion } from './action-version.js';
import { formatRejectedMint, inspectPmakIdentity, maskPmakDiagnostic } from './pmak-diagnostics.js';

export type PostmanStack = 'prod' | 'beta';

export interface ResolveInputs {
  postmanApiKey?: string;
  postmanAccessToken?: string;
  postmanTeamId?: string;
  postmanRegion?: string;
  postmanStack?: string;
  writeGithubSecret: boolean;
  accessTokenSecretName: string;
  teamIdSecretName: string;
  githubToken?: string;
}

export interface ResolveResult {
  token: string;
  teamId: string;
  skipped: boolean;
}

export interface CoreLike {
  info(message: string): void;
  warning?(message: string): void;
  debug?(message: string): void;
  error?(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(value: string): void;
}

/**
 * Adapt the @actions/core facade this action already depends on to the shared
 * LogSink. Debug is dropped rather than folded into info when the host has no
 * debug channel: debug output is opt-in, and promoting it would put verbose
 * diagnostics into every consumer's default log. Warning and error fall back to
 * the next channel the host does provide, so a failure is never silent.
 */
export function coreLogSink(core: CoreLike): LogSink {
  return {
    debug: (message) => core.debug?.(message),
    info: (message) => core.info(message),
    warning: (message) => (core.warning ?? core.info)(message),
    error: (message) => (core.error ?? core.warning ?? core.info)(message)
  };
}

export interface ExecFileOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type ExecFile = (file: string, args: string[], options?: ExecFileOptions) => Promise<ExecFileResult>;

export interface ResolveDependencies {
  core: CoreLike;
  fetcher: Fetcher;
  execFile: ExecFile;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; otherwise built over `core` when the run starts. */
  logger?: Logger;
}

export interface ActionInputReader {
  getInput(name: string, options?: { required?: boolean }): string;
}

const DEFAULT_ACCESS_TOKEN_SECRET_NAME = 'POSTMAN_ACCESS_TOKEN';
const DEFAULT_TEAM_ID_SECRET_NAME = 'POSTMAN_TEAM_ID';

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanInput(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value: true or false`);
}

export function resolvePostmanApiHost(stackInput: string | undefined, regionInput: string | undefined): string {
  const stack = normalizeOptional(stackInput) ?? 'prod';
  const region = normalizeOptional(regionInput) ?? 'us';
  if (region !== 'us' && region !== 'eu') {
    throw new Error(`postman-region must be one of: us, eu; got: ${region}`);
  }
  if (stack === 'prod' && region === 'eu') return 'https://api.eu.postman.com';
  if (stack === 'prod') return 'https://api.getpostman.com';
  if (stack === 'beta' && region === 'eu') {
    throw new Error('postman-region=eu is only supported with postman-stack=prod');
  }
  if (stack === 'beta') return 'https://api.getpostman-beta.com';
  throw new Error(`postman-stack must be one of: prod, beta; got: ${stack}`);
}

export function readInputsFromAction(
  input: ActionInputReader,
  env: NodeJS.ProcessEnv = process.env
): ResolveInputs {
  // Inputs win; fall back to plain POSTMAN_* env vars so Jenkins withCredentials
  // (which binds a secret to a bare env var, no INPUT_ prefix) works flag-free.
  return {
    postmanApiKey:
      normalizeOptional(input.getInput('postman-api-key')) ??
      normalizeOptional(env.POSTMAN_API_KEY),
    postmanAccessToken:
      normalizeOptional(input.getInput('postman-access-token')) ??
      normalizeOptional(env.POSTMAN_ACCESS_TOKEN),
    postmanTeamId: normalizeOptional(input.getInput('postman-team-id')),
    postmanRegion: normalizeOptional(input.getInput('postman-region')) ?? 'us',
    postmanStack: normalizeOptional(input.getInput('postman-stack')) ?? 'prod',
    writeGithubSecret: parseBooleanInput('write-github-secret', input.getInput('write-github-secret'), false),
    accessTokenSecretName: normalizeOptional(input.getInput('access-token-secret-name')) ?? DEFAULT_ACCESS_TOKEN_SECRET_NAME,
    teamIdSecretName: normalizeOptional(input.getInput('team-id-secret-name')) ?? DEFAULT_TEAM_ID_SECRET_NAME,
    githubToken: normalizeOptional(input.getInput('github-token'))
  };
}

export function readInputsFromEnv(env: NodeJS.ProcessEnv = process.env): ResolveInputs {
  const getInput = (name: string): string => env[`INPUT_${name.replace(/-/g, '_').toUpperCase()}`] ?? '';
  return readInputsFromAction({ getInput }, env);
}

function createHeaders(entries: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

const DIAGNOSTIC_DETAIL_MAX = 200;
const DIAGNOSTIC_VALUE_MAX = 120;
const EXEC_OUTPUT_CAP_BYTES = 8 * 1024;
const EXEC_OUTPUT_TRUNCATION_MARKER = '...[truncated]';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g');
const ANSI_SHORT = new RegExp(`${ESC}[@-_]`, 'g');
// C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F) — built without control-char regex literals.
const CONTROL_CHARS = new RegExp(
  `[${Array.from({ length: 0x20 }, (_, i) => `\\u${i.toString(16).padStart(4, '0')}`).join('')}` +
    '\\u007f' +
    `${Array.from({ length: 0x20 }, (_, i) => `\\u${(0x80 + i).toString(16).padStart(4, '0')}`).join('')}]`,
  'g'
);

/** Neutralize ANSI/C0/C1 controls and collapse to a single safe diagnostic line. */
function collapseToOneLine(value: string): string {
  return value
    .replace(ANSI_CSI, ' ')
    .replace(ANSI_OSC, ' ')
    .replace(ANSI_SHORT, ' ')
    .replace(CONTROL_CHARS, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

function redactKnownSecrets(text: string, secrets: Array<string | undefined>): string {
  const values = secrets
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry && entry.length > 0))
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of values) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

/** Collapse, redact known secrets, and bound untrusted detail for one-line CI diagnostics. */
function sanitizeDiagnosticDetail(
  value: unknown,
  secrets: Array<string | undefined> = [],
  maxLength = DIAGNOSTIC_DETAIL_MAX
): string {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === 'string') {
    text = value;
  } else if (value == null) {
    return '';
  } else {
    text = String(value);
  }
  text = redactKnownSecrets(collapseToOneLine(text), secrets);
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}...`;
  }
  return text;
}

function createBoundedOutputCollector(capBytes: number): {
  onData: (chunk: Buffer) => void;
  finalize: () => string;
} {
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;

  return {
    onData(chunk: Buffer) {
      // Stream is drained by the data listener even when retention is full.
      if (retainedBytes >= capBytes) {
        truncated = true;
        return;
      }
      const remaining = capBytes - retainedBytes;
      if (chunk.length <= remaining) {
        retained.push(chunk);
        retainedBytes += chunk.length;
        return;
      }
      retained.push(chunk.subarray(0, remaining));
      retainedBytes = capBytes;
      truncated = true;
    },
    finalize() {
      const text = Buffer.concat(retained, retainedBytes).toString('utf8');
      return truncated ? `${text}${EXEC_OUTPUT_TRUNCATION_MARKER}` : text;
    }
  };
}

function formatDiagnosticValue(value: string | undefined, maxLength = DIAGNOSTIC_VALUE_MAX): string {
  return sanitizeDiagnosticDetail(value ?? '', [], maxLength);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    const record = getRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function stringifyCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  const record = getRecord(value);
  if (record) {
    return stringifyCandidate(record.id);
  }
  return undefined;
}

function extractAccessToken(payload: unknown): string | undefined {
  return stringifyCandidate(readPath(payload, ['access_token']))
    ?? stringifyCandidate(readPath(payload, ['session', 'token']));
}

interface MeIdentity {
  teamId: string | undefined;
  userId: string | undefined;
  fullName: string | undefined;
}

function extractMeIdentity(payload: unknown): MeIdentity {
  const teamIdCandidates = [
    ['user', 'teamId'],
    ['user', 'team'],
    ['teamId'],
    ['team', 'id'],
    ['team'],
    ['identity', 'team'],
    ['session', 'identity', 'team']
  ];

  let teamId: string | undefined;
  for (const path of teamIdCandidates) {
    teamId = stringifyCandidate(readPath(payload, path));
    if (teamId) break;
  }

  const userId =
    stringifyCandidate(readPath(payload, ['user', 'id'])) ??
    stringifyCandidate(readPath(payload, ['id']));

  const fullName =
    stringifyCandidate(readPath(payload, ['user', 'fullName'])) ??
    stringifyCandidate(readPath(payload, ['fullName']));

  return { teamId, userId, fullName };
}


async function mintServiceToken(inputs: ResolveInputs, apiHost: string, fetcher: Fetcher, logger: Logger): Promise<string> {
  const endpoint = `${apiHost}/service-account-tokens`;
  const secrets = [inputs.postmanApiKey, inputs.postmanAccessToken];
  const remediation =
    'Verify the postman-api-key, team, stack, and region; retry; contact Postman support if the failure persists.';
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': inputs.postmanApiKey ?? ''
      },
      body: JSON.stringify({ apiKey: inputs.postmanApiKey })
    });
  } catch (error) {
    // Transport never reached a status. Log the attempt itself so a DNS or TLS
    // failure against the wrong host is distinguishable from a rejected key.
    logger.failure(
      'mint request failed before a response',
      error,
      httpFields({ method: 'POST', url: endpoint, durationMs: Date.now() - started })
    );
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `POST ${endpoint} (mint service-account token) failed: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  const requestId = response.headers?.get?.('x-request-id') ?? undefined;
  logger.debug(
    'mint response',
    httpFields({
      method: 'POST',
      url: endpoint,
      status: response.status,
      durationMs: Date.now() - started,
      requestId
    })
  );
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    logger.failure(
      'mint response body unreadable',
      error,
      httpFields({ method: 'POST', url: endpoint, status: response.status, requestId })
    );
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `POST ${endpoint} (mint service-account token) failed to read response body: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    const status = response.status;
    logger.error(
      'mint rejected',
      httpFields({
        method: 'POST',
        url: endpoint,
        status,
        durationMs: Date.now() - started,
        requestId,
        bodyPreview: sanitizeDiagnosticDetail(body, secrets)
      })
    );
    if (status === 401 || status === 403) {
      const original = `POST ${endpoint} (mint service-account token): The postman-api-key was rejected (HTTP ${status}); confirm it is a valid, enabled PMAK for the intended team.`;
      const diagnostic = await inspectPmakIdentity({
        apiBaseUrl: apiHost,
        apiKey: inputs.postmanApiKey ?? '',
        fetchImpl: fetcher
      });
      throw new Error(formatRejectedMint(maskPmakDiagnostic(original, secrets), diagnostic));
    }
    if (status === 400 && body.toLowerCase().includes('service accounts not enabled')) {
      throw new Error(
        `POST ${endpoint} (mint service-account token): Service accounts are not enabled for this team (targeted by postman-api-key); enable them in Team Settings or use a team where they are.`
      );
    }
    const detail = sanitizeDiagnosticDetail(body, secrets);
    throw new Error(
      `POST ${endpoint} (mint service-account token) failed (HTTP ${status})${detail ? `: ${detail}` : ''}. ${remediation}`
    );
  }
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (error) {
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `POST ${endpoint} (mint service-account token) returned malformed JSON: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  const token = extractAccessToken(payload);
  if (!token) {
    throw new Error(
      `POST ${endpoint} (mint service-account token) succeeded but response contained no access token. ${remediation}`
    );
  }
  return token;
}

async function resolveTeamIdAndIdentity(inputs: ResolveInputs, apiHost: string, token: string, fetcher: Fetcher, logger: Logger): Promise<MeIdentity & { teamId: string }> {
  const endpoint = `${apiHost}/me`;
  const secrets = [token, inputs.postmanApiKey, inputs.postmanAccessToken];
  const remediation =
    'Verify the access token or postman-api-key, team, stack, and region, or supply a verified postman-team-id.';
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      headers: createHeaders({
        Authorization: `Bearer ${token}`,
        'x-api-key': inputs.postmanApiKey
      })
    });
  } catch (error) {
    logger.failure(
      'identity request failed before a response',
      error,
      httpFields({ method: 'GET', url: endpoint, durationMs: Date.now() - started })
    );
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `GET ${endpoint} (resolve team identity) failed: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  const requestId = response.headers?.get?.('x-request-id') ?? undefined;
  logger.debug(
    'identity response',
    httpFields({
      method: 'GET',
      url: endpoint,
      status: response.status,
      durationMs: Date.now() - started,
      requestId
    })
  );
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    logger.failure(
      'identity response body unreadable',
      error,
      httpFields({ method: 'GET', url: endpoint, status: response.status, requestId })
    );
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `GET ${endpoint} (resolve team identity) failed to read response body: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    const detail = sanitizeDiagnosticDetail(body, secrets);
    logger.error(
      'identity rejected',
      httpFields({
        method: 'GET',
        url: endpoint,
        status: response.status,
        durationMs: Date.now() - started,
        requestId,
        bodyPreview: detail
      })
    );
    throw new Error(
      `GET ${endpoint} (resolve team identity) failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}. ${remediation}`
    );
  }
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (error) {
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `GET ${endpoint} (resolve team identity) returned malformed JSON: ${cause}. ${remediation}`,
      { cause: error }
    );
  }
  const identity = extractMeIdentity(payload);
  if (!identity.teamId) {
    throw new Error(
      `GET ${endpoint} (resolve team identity) response did not include a team id. ${remediation}`
    );
  }
  return identity as MeIdentity & { teamId: string };
}

async function writeSecret(
  name: string,
  value: string,
  repository: string,
  githubToken: string,
  dependencies: ResolveDependencies
): Promise<void> {
  await dependencies.execFile('gh', ['secret', 'set', name, '--repo', repository], {
    env: {
      ...(dependencies.env ?? process.env),
      GH_TOKEN: githubToken
    },
    input: value
  });
}

async function writeGitHubSecrets(result: ResolveResult, inputs: ResolveInputs, dependencies: ResolveDependencies): Promise<void> {
  const env = dependencies.env ?? process.env;
  const repository = normalizeOptional(env.GITHUB_REPOSITORY);
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required when write-github-secret is true.');
  }
  if (!inputs.githubToken) {
    throw new Error("github-token is required when write-github-secret is 'true'. The default GITHUB_TOKEN cannot write repo secrets; use a PAT or GitHub App installation token with secrets write permission.");
  }

  const secrets = [inputs.githubToken, result.token, inputs.postmanApiKey, inputs.postmanAccessToken];
  const repoLabel = formatDiagnosticValue(repository);
  const accessSecretLabel = formatDiagnosticValue(inputs.accessTokenSecretName);
  const teamSecretLabel = formatDiagnosticValue(inputs.teamIdSecretName);
  const secretsWriteRemediation =
    'Ensure github-token has secrets-write permission for the repository, then retry.';

  try {
    await dependencies.execFile('gh', ['--version']);
  } catch (error) {
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `gh CLI not found on runner${cause ? ` (${cause})` : ''}. Use a runner image that includes gh (the default GitHub-hosted runners do), or install it before invoking this action.`,
      { cause: error }
    );
  }

  try {
    await writeSecret(inputs.accessTokenSecretName, result.token, repository, inputs.githubToken, dependencies);
  } catch (error) {
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `Failed to write GitHub secret ${accessSecretLabel} to repository ${repoLabel}: ${cause}. ${secretsWriteRemediation}`,
      { cause: error }
    );
  }

  try {
    await writeSecret(inputs.teamIdSecretName, result.teamId, repository, inputs.githubToken, dependencies);
  } catch (error) {
    const cause = sanitizeDiagnosticDetail(error, secrets);
    throw new Error(
      `Partial success: wrote GitHub secret ${accessSecretLabel} to repository ${repoLabel}, but failed to write ${teamSecretLabel}: ${cause}. Ensure github-token has secrets-write permission, retry the failed write, and reconcile or rotate the already-written ${accessSecretLabel} secret if needed.`,
      { cause: error }
    );
  }

  dependencies.core.info(`Wrote secrets: ${accessSecretLabel}, ${teamSecretLabel}`);
}

function validateInputs(inputs: ResolveInputs): void {
  resolvePostmanApiHost(inputs.postmanStack, inputs.postmanRegion);
  if (!inputs.postmanAccessToken && !inputs.postmanApiKey) {
    throw new Error('postman-api-key is required when postman-access-token is not provided.');
  }
  if (inputs.writeGithubSecret && !inputs.githubToken) {
    throw new Error("github-token is required when write-github-secret is 'true'. The default GITHUB_TOKEN cannot write repo secrets; use a PAT or GitHub App installation token with secrets write permission.");
  }
}

function warn(core: CoreLike, message: string): void {
  if (core.warning) {
    core.warning(message);
    return;
  }
  core.info(message);
}

export async function runResolveServiceToken(inputs: ResolveInputs, dependencies: ResolveDependencies): Promise<ResolveResult> {
  const actionVersion = resolveActionVersion();
  const logger =
    dependencies.logger ??
    createLogger({
      sink: coreLogSink(dependencies.core),
      env: dependencies.env ?? process.env,
      fields: { action: 'postman-resolve-service-token-action', version: actionVersion }
    });
  // Register before the first line is emitted: a credential that reaches a log
  // before the redactor knows it is already leaked.
  logger.addSecret(inputs.postmanApiKey);
  logger.addSecret(inputs.postmanAccessToken);
  logger.addSecret(inputs.githubToken);

  const telemetry = createTelemetryContext({ action: 'postman-resolve-service-token-action', actionVersion, logger: dependencies.core });
  logger.debug('run start', {
    stack: inputs.postmanStack,
    region: inputs.postmanRegion,
    credential: inputs.postmanAccessToken ? 'provided-access-token' : 'pmak-mint',
    team_id_provided: Boolean(inputs.postmanTeamId),
    write_github_secret: inputs.writeGithubSecret
  });
  try {
    const result = await runResolveServiceTokenInner(inputs, { ...dependencies, logger }, telemetry);
    telemetry.setAccountType('service_account');
    telemetry.emitCompletion('success');
    logger.debug('run complete', { skipped: result.skipped });
    return result;
  } catch (error) {
    telemetry.setAccountType('service_account');
    telemetry.emitCompletion('failure');
    logger.failure('run failed', error);
    throw error;
  }
}

async function runResolveServiceTokenInner(inputs: ResolveInputs, dependencies: ResolveDependencies, telemetry: ReturnType<typeof createTelemetryContext>): Promise<ResolveResult> {
  const logger =
    dependencies.logger ??
    createLogger({ sink: coreLogSink(dependencies.core), env: dependencies.env ?? process.env });
  validateInputs(inputs);
  const apiHost = resolvePostmanApiHost(inputs.postmanStack, inputs.postmanRegion);
  const skipped = Boolean(inputs.postmanAccessToken);
  const token =
    inputs.postmanAccessToken ??
    (await logger.phase(
      'mint-service-token',
      () => mintServiceToken(inputs, apiHost, dependencies.fetcher, logger),
      { api_host: apiHost }
    ));
  // The minted token is a credential in its own right: register it before it
  // can reach any later line or error.
  logger.addSecret(token);
  dependencies.core.setSecret(token);
  if (skipped) {
    warn(dependencies.core, 'Using a provided postman-access-token. Prefer minting a fresh service-account token with postman-api-key unless this workflow intentionally manages token rotation outside this action.');
  }

  let teamId: string;
  if (inputs.postmanTeamId) {
    teamId = inputs.postmanTeamId;
    dependencies.core.info(`Using provided postman-team-id ${formatDiagnosticValue(teamId)}.`);
  } else {
    const identity = await logger.phase(
      'resolve-team-identity',
      () => resolveTeamIdAndIdentity(inputs, apiHost, token, dependencies.fetcher, logger),
      { api_host: apiHost }
    );
    teamId = identity.teamId;
    if (!skipped) {
      const userId = formatDiagnosticValue(identity.userId ?? 'unknown');
      const fullName = formatDiagnosticValue(identity.fullName ?? 'unknown');
      const teamLabel = formatDiagnosticValue(teamId);
      dependencies.core.info(`resolve-service-token: minted access token for team ${teamLabel} (user ${userId} ${fullName})`);
    }
  }

  telemetry.setTeamId(teamId);
  const result: ResolveResult = { token, teamId, skipped };
  dependencies.core.setOutput('token', result.token);
  dependencies.core.setOutput('team-id', result.teamId);
  dependencies.core.setOutput('skipped', result.skipped ? 'true' : 'false');

  if (inputs.writeGithubSecret) {
    await logger.phase('write-github-secrets', () => writeGitHubSecrets(result, inputs, dependencies));
  }

  return result;
}

export function createNodeExecFile(baseEnv: NodeJS.ProcessEnv = process.env): ExecFile {
  return (file, args, options) => new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options?.env ? { ...baseEnv, ...options.env } : baseEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdoutCollector = createBoundedOutputCollector(EXEC_OUTPUT_CAP_BYTES);
    const stderrCollector = createBoundedOutputCollector(EXEC_OUTPUT_CAP_BYTES);
    let interruptedSignal: NodeJS.Signals | undefined;

    const cleanupSignalHandlers = (): void => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    };
    const handleSignal = (signal: NodeJS.Signals): void => {
      interruptedSignal = signal;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    child.stdout.on('data', (chunk: Buffer) => stdoutCollector.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrCollector.onData(chunk));
    child.on('error', (error) => {
      cleanupSignalHandlers();
      reject(error);
    });
    child.on('close', (code) => {
      cleanupSignalHandlers();
      const stdout = stdoutCollector.finalize();
      const stderr = stderrCollector.finalize();
      if (interruptedSignal) {
        reject(new Error(`Command interrupted by ${interruptedSignal}: ${file} ${args.join(' ')}`));
        return;
      }
      if (code && code !== 0) {
        // Prefer bounded stderr as the cause so operator diagnostics stay intelligible;
        // fall back to the command line only when the child emitted no stderr.
        const detail = stderr || `${file} ${args.join(' ')}`;
        reject(new Error(`Command failed with exit code ${code}: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (options?.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}