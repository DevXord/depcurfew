// Every rule has fixtures in tests/fixtures/doctor/<rule>/: directories named fires-* must produce exactly the
// findings in their expected.json, directories named passes-* must produce none for that rule. The date is fixed, because
// runtime-end-of-life and the fixes of manager-version-too-old depend on which Node.js lines are supported that day.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RULES, runDoctor } from '../../src/doctor/index.ts';
import { PolicyError } from '../../src/apply/index.ts';

const ROOT = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));

function directories(path: string): string[] {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

describe('doctor rules', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('every rule has fixtures that fire and fixtures that pass', () => {
    for (const rule of RULES) {
      const cases = directories(join(ROOT, rule.id));
      expect(cases.some((name) => name.startsWith('fires')), `${rule.id} has a fires-* fixture`).toBe(true);
      expect(cases.some((name) => name.startsWith('passes')), `${rule.id} has a passes-* fixture`).toBe(true);
    }
  });

  const cases = RULES.flatMap((rule) => directories(join(ROOT, rule.id)).map((name) => [rule.id, name] as const));
  it.each(cases)('%s / %s', (ruleId, name) => {
    const directory = join(ROOT, ruleId, name);
    const report = runDoctor(join(directory, 'repo'), { invalidPolicy: 'report' });
    const findings = report.findings
      .filter((finding) => finding.rule === ruleId)
      .map(({ rule: _rule, ...finding }) => finding);
    if (name.startsWith('passes')) {
      expect(findings).toEqual([]);
      return;
    }
    expect(findings).toEqual(JSON.parse(readFileSync(join(directory, 'expected.json'), 'utf8')));
  });
});

describe('runDoctor with an invalid depcurfew.json', () => {
  it('throws PolicyError unless asked to report it, as the library API promises', () => {
    const repo = join(ROOT, 'invalid-policy', 'fires-schema', 'repo');
    expect(() => runDoctor(repo)).toThrow(PolicyError);
    const report = runDoctor(repo, { invalidPolicy: 'report' });
    expect(report.policy).toBe('invalid');
    expect(report.notices).toContainEqual({
      level: 'note',
      code: 'policy-invalid',
      location: { file: 'depcurfew.json' },
      message: 'depcurfew.json is invalid: only the rules that do not need a policy ran',
      file: 'depcurfew.json',
      fix: 'Fix what the invalid-policy finding lists, then run depcurfew doctor again',
    });
  });
});

describe('the list of what doctor checked', () => {
  it('has a plain sentence for what every rule checks', async () => {
    const { USER_RULES } = await import('../../src/user/doctor.ts');
    for (const rule of [...RULES, ...USER_RULES]) expect(rule.checks, rule.id).toMatch(/^\S.{10,}[^.]$/u);
  });
});
