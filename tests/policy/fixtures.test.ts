import { describe, expect, it } from 'vitest';
import { formatIssue, parsePolicy } from '../../src/policy/validate.ts';
import { policyFixtureNames, readFixture } from './fixture-files.ts';

describe('policy fixtures', () => {
  const names = policyFixtureNames();

  it('exist, both valid and invalid', () => {
    expect(names.filter((name) => readFixture(name, 'resolved.json') !== undefined).length).toBeGreaterThan(2);
    expect(names.filter((name) => readFixture(name, 'errors.txt') !== undefined).length).toBeGreaterThan(10);
  });

  it.each(names)('%s', (name) => {
    const input = readFixture(name, 'depgate.json');
    const resolved = readFixture(name, 'resolved.json');
    const errors = readFixture(name, 'errors.txt');
    expect(input, 'depgate.json').toBeDefined();
    expect((resolved === undefined) !== (errors === undefined), 'exactly one of resolved.json and errors.txt').toBe(true);

    const result = parsePolicy(input ?? '');
    if (resolved !== undefined) {
      expect(result).toEqual({ ok: true, policy: JSON.parse(resolved) });
    } else {
      expect(result.ok).toBe(false);
      const issues = result.ok ? [] : result.issues.map(formatIssue);
      expect(issues).toEqual((errors ?? '').trimEnd().split('\n'));
    }
  });
});
