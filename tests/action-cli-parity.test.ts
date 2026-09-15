import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * P3 drift gate (.plans/e2e-suite-tuneup.md): the CLI maintains a hard-coded
 * input-name array (cliInputNames) separate from action.yml. Assert the two
 * stay equal so a new action input cannot ship without its CLI flag (and
 * vice versa). This action has no CLI-only inputs. action.yml is parsed with
 * a line scanner because this package has no yaml dependency.
 */

function actionManifestInputs(): string[] {
  const text = readFileSync(resolve(repoRoot, 'action.yml'), 'utf8');
  const inputs: string[] = [];
  let inInputs = false;
  for (const line of text.split('\n')) {
    if (/^inputs:\s*$/.test(line)) {
      inInputs = true;
      continue;
    }
    if (/^\S/.test(line)) inInputs = false;
    if (inInputs) {
      const match = line.match(/^ {2}([a-z0-9-]+):\s*$/);
      if (match) inputs.push(match[1]);
    }
  }
  if (inputs.length === 0) throw new Error('No inputs parsed from action.yml');
  return inputs;
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const cliInputNames = \[([^\]]*)\]/);
  if (!match) throw new Error('cliInputNames array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag', () => {
    const cli = new Set(cliInputNames());
    const missing = actionManifestInputs().filter((name) => !cli.has(name));
    expect(missing).toEqual([]);
  });

  it('every CLI input flag is an action.yml input', () => {
    const manifest = new Set(actionManifestInputs());
    const extras = cliInputNames().filter((name) => !manifest.has(name));
    expect(extras).toEqual([]);
  });
});

function actionManifestDescription(): string {
  const text = readFileSync(resolve(repoRoot, 'action.yml'), 'utf8');
  for (const line of text.split('\n')) {
    if (/^inputs:\s*$/.test(line)) break;
    const match = line.match(/^description:\s*(.*)$/);
    if (match) return match[1].trim();
  }
  throw new Error('No top-level description parsed from action.yml');
}

describe('action.yml marketplace description', () => {
  it('fits the GitHub Marketplace 125-character limit', () => {
    // Marketplace silently keeps the old listing text when the description
    // exceeds 125 characters, so pin the parsed manifest value length.
    expect(actionManifestDescription().length).toBeLessThanOrEqual(125);
  });
});
