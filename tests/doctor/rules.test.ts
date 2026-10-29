// Every rule has fixtures in tests/fixtures/doctor/<rule>/: directories named fires-* must produce exactly the
// findings in their expected.json, directories named passes-* must produce none for that rule.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES, runDoctor } from '../../src/doctor/index.ts';

const ROOT = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));

function directories(path: string): string[] {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

describe('doctor rules', () => {
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
    const report = runDoctor(join(directory, 'repo'));
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
