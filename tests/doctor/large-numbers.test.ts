// TOML integers beyond Number.MAX_SAFE_INTEGER are read as BigInt; doctor must not fail on them (JSON.stringify throws
// on a BigInt), but say that it cannot read the value.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';
import { delayMinutes } from '../../src/doctor/durations.ts';
import { poetry } from '../../src/knowledge/poetry.ts';
import { pnpm } from '../../src/knowledge/pnpm.ts';

const POETRY = fileURLToPath(new URL('../fixtures/repos/poetry-basic/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('a delay too large for a number', () => {
  it('is not a delay doctor can read', () => {
    expect(delayMinutes(poetry, 99999999999999999999n, undefined)).toEqual({ ok: false, reason: '99999999999999999999 is too large to be a delay' });
    expect(delayMinutes(pnpm, 1e308, undefined)).toEqual({ ok: false, reason: '1e+308 is too large to be a delay' });
  });

  it('gives a notice instead of a crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-bigint-'));
    temporary.push(root);
    cpSync(POETRY, root, { recursive: true });
    writeFileSync(join(root, 'poetry.toml'), '[solver]\nmin-release-age = 99999999999999999999\n');
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'dependabot.yml'), 'version: 2\nupdates:\n  - package-ecosystem: "pip"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n');
    const report = runDoctor(root);
    expect(report.notices).toContainEqual({
      message: 'Poetry: cannot read solver.min-release-age in poetry.toml: 99999999999999999999 is too large to be a delay',
      file: 'poetry.toml',
    });
    expect(report.findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });
});
