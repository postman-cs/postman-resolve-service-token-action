/**
 * WS4 route-manifest ratchet.
 *
 * Statically extracts every service/method/path triple this action calls out of
 * `src/`, then diffs that surface against `tests/contract/route-manifest.json`
 * in both directions: a route in `src/` with no manifest entry fails, and a
 * manifest entry with no route in `src/` fails. A row claiming `simulated` must
 * name cassette files that exist. Unreadable HTTP call sites fail closed rather
 * than disappearing from the surface.
 *
 * The extractor/validator is the shared WS4 contract published by automation-core.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ROUTE_CLASSIFICATIONS,
  extractRoutesFromSource,
  validateRouteManifest,
  type RouteManifest,
  type RouteManifestRoute
} from '@postman-cs/automation-core/route-manifest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceRoot = path.join(repoRoot, 'src');
const manifestPath = path.join(repoRoot, 'tests', 'contract', 'route-manifest.json');

/**
 * Extraction config for this action. Every call is a plain fetch against the
 * Postman API host, reached through an injected `fetcher`/`fetchImpl` seam.
 *
 * `serviceAliases` is the fail-closed seam: a base-URL expression with no entry
 * here is reported as an unattributed call site and fails the gate.
 * `allowedPassthroughs` declares the one call whose URL is intentionally opaque
 * because the enclosing function is a fetch adapter, not a route caller.
 */
export const EXTRACTION_CONFIG = {
  serviceAliases: { apiHost: 'postman-api', baseUrl: 'postman-api' },
  allowedPassthroughs: [
    {
      file: 'pmak-diagnostics.ts',
      urlExpression: 'url',
      reason:
        'Default fetch adapter `(url, init) => fetch(url, init)` used when no fetchImpl is injected. It forwards whatever URL the caller already built; the routes it carries are extracted at their own call sites.'
    }
  ]
} as const;

/** Moves only when the wire surface deliberately changes. */
const EXPECTED_ROUTE_COUNT = 2;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function loadManifest(): RouteManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RouteManifest;
}

function verifyMutated(mutate: (manifest: RouteManifest) => void) {
  const manifest = structuredClone(loadManifest());
  mutate(manifest);
  return validateRouteManifest({ repoRoot, sourceRoot, manifest, ...EXTRACTION_CONFIG });
}

describe('route manifest contract', () => {
  it('RS-RM-001: the committed manifest is schema 1 and well formed', () => {
    const manifest = loadManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.routes.length).toBe(EXPECTED_ROUTE_COUNT);

    const ids = new Set<string>();
    for (const route of manifest.routes) {
      expect(ROUTE_CLASSIFICATIONS).toContain(route.classification);
      expect(route.method).toBe(route.method.toUpperCase());
      expect(route.path.startsWith('/')).toBe(true);
      expect(ids.has(route.id), `duplicate id ${route.id}`).toBe(false);
      ids.add(route.id);
      if (route.classification === 'simulated') {
        expect(route.cassettes?.length, `${route.id} simulated without cassettes`).toBeGreaterThan(0);
      } else {
        expect(route.reason?.trim().length, `${route.id} missing reason`).toBeGreaterThan(0);
      }
    }
  });

  it('RS-RM-002: the committed manifest matches the extracted surface exactly', () => {
    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: loadManifest(),
      ...EXTRACTION_CONFIG
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.extractedRoutes.length).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('RS-RM-003: extraction resolves both routes and leaves nothing unattributed', () => {
    const extraction = extractRoutesFromSource({ sourceRoot, ...EXTRACTION_CONFIG });
    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id).sort()).toEqual([
      'postman-api GET /me',
      'postman-api POST /service-account-tokens'
    ]);

    // The mint and identity routes both bind a local `const endpoint` in the
    // same file. Nearest-preceding-binding resolution keeps them distinct; a
    // regression collapses the mint route onto /me.
    const mint = extraction.routes.find((route) => route.id === 'postman-api POST /service-account-tokens');
    expect(mint?.sources).toEqual(['index.ts:328']);

    // /me is reached from the action entry, the memoized identity helper, and
    // the PMAK diagnostic probe (the last nested inside raceAbort(...)).
    const me = extraction.routes.find((route) => route.id === 'postman-api GET /me');
    expect(me?.sources).toEqual([
      'credential-identity.ts:58',
      'index.ts:435',
      'pmak-diagnostics.ts:66'
    ]);
  });
});

describe('route manifest ratchet negatives', () => {
  it('RS-RM-010: a route in src/ with no manifest entry fails the gate', () => {
    const result = verifyMutated((manifest) => {
      manifest.routes = manifest.routes.filter(
        (route) => route.id !== 'postman-api.service-account-tokens.mint'
      );
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          /unmanifested route/i.test(error) && /postman-api POST \/service-account-tokens/.test(error)
      )
    ).toBe(true);
  });

  it('RS-RM-011: a manifest entry with no route in src/ fails as stale', () => {
    const result = verifyMutated((manifest) => {
      manifest.routes.push({
        id: 'postman-api.teams',
        service: 'postman-api',
        method: 'GET',
        path: '/teams',
        classification: 'live-only',
        reason: 'fixture'
      });
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /stale manifest entry/i.test(error) && /\/teams/.test(error))).toBe(
      true
    );
  });

  it('RS-RM-012: simulated without cassettes fails', () => {
    const result = verifyMutated((manifest) => {
      const route = manifest.routes[0] as RouteManifestRoute;
      route.classification = 'simulated';
      delete route.reason;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /simulated but lists no cassettes/i.test(error))).toBe(true);
  });

  it('RS-RM-013: simulated naming a cassette file that does not exist fails', () => {
    const result = verifyMutated((manifest) => {
      const route = manifest.routes[0] as RouteManifestRoute;
      route.classification = 'simulated';
      route.cassettes = ['tests/contract/cassettes/mint.json'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /cassette not found/i.test(error))).toBe(true);
  });

  it('RS-RM-014: a non-simulated row without a reason fails', () => {
    const result = verifyMutated((manifest) => {
      delete (manifest.routes[0] as RouteManifestRoute).reason;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /reason is required/i.test(error))).toBe(true);
  });

  it('RS-RM-015: an invalid classification and a bad schemaVersion fail', () => {
    const badClass = verifyMutated((manifest) => {
      (manifest.routes[0] as RouteManifestRoute).classification =
        'partially-simulated' as RouteManifestRoute['classification'];
    });
    expect(badClass.ok).toBe(false);
    expect(badClass.errors.some((error) => /classification must be one of/i.test(error))).toBe(true);

    const badSchema = verifyMutated((manifest) => {
      manifest.schemaVersion = 99;
    });
    expect(badSchema.ok).toBe(false);
    expect(badSchema.errors.some((error) => /schemaVersion must be 1/i.test(error))).toBe(true);
  });
});

describe('route manifest ratchet on a fixture tree', () => {
  function makeFixture(files: Record<string, string>): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'resolve-route-manifest-'));
    tempDirs.push(fixtureRoot);
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(fixtureRoot, 'src', relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return fixtureRoot;
  }

  it('RS-RM-020: a throwaway route added to src/ fails as unmanifested', () => {
    const base = [
      'export async function mint(fetcher: typeof fetch, apiHost: string): Promise<Response> {',
      '  const endpoint = `${apiHost}/service-account-tokens`;',
      '  return fetcher(endpoint, { method: "POST" });',
      '}',
      ''
    ].join('\n');

    const manifest: RouteManifest = {
      schemaVersion: 1,
      routes: [
        {
          id: 'postman-api.mint',
          service: 'postman-api',
          method: 'POST',
          path: '/service-account-tokens',
          classification: 'live-only',
          reason: 'fixture'
        }
      ]
    };

    const fixtureRoot = makeFixture({ 'mint.ts': base });
    const clean = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { apiHost: 'postman-api' }
    });
    expect(clean.errors).toEqual([]);
    expect(clean.ok).toBe(true);

    writeFileSync(
      path.join(fixtureRoot, 'src', 'mint.ts'),
      `${base}export async function throwaway(fetcher: typeof fetch, apiHost: string): Promise<Response> {\n  return fetcher(\`\${apiHost}/throwaway-route\`, { method: "PUT" });\n}\n`
    );

    const ratcheted = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { apiHost: 'postman-api' }
    });
    expect(ratcheted.ok).toBe(false);
    expect(
      ratcheted.errors.some(
        (error) => /unmanifested route/i.test(error) && /PUT \/throwaway-route/.test(error)
      )
    ).toBe(true);
  });

  it('RS-RM-021: a call to an unmapped host fails closed', () => {
    const fixtureRoot = makeFixture({
      'vendor.ts': [
        'export async function callVendor(fetcher: typeof fetch, vendorHost: string): Promise<Response> {',
        '  return fetcher(`${vendorHost}/v1/tokens`, { method: "POST" });',
        '}',
        ''
      ].join('\n')
    });

    const result = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest: { schemaVersion: 1, routes: [] },
      serviceAliases: { apiHost: 'postman-api' }
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => /unattributed HTTP call site/i.test(error) && /vendorHost/.test(error)
      )
    ).toBe(true);
  });

  it('RS-RM-022: an undeclared fetch adapter fails closed rather than being ignored', () => {
    const fixtureRoot = makeFixture({
      'adapter.ts': [
        'export function makeFetcher(custom?: typeof fetch): typeof fetch {',
        '  return custom ?? ((url: string, init?: RequestInit) => fetch(url, init));',
        '}',
        ''
      ].join('\n')
    });

    const undeclared = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest: { schemaVersion: 1, routes: [] },
      serviceAliases: { apiHost: 'postman-api' }
    });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors.some((error) => /unattributed HTTP call site/i.test(error))).toBe(true);

    const declared = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest: { schemaVersion: 1, routes: [] },
      serviceAliases: { apiHost: 'postman-api' },
      allowedPassthroughs: [
        { file: 'adapter.ts', urlExpression: 'url', reason: 'fixture fetch adapter' }
      ]
    });
    expect(declared.errors).toEqual([]);
    expect(declared.ok).toBe(true);
  });
});
