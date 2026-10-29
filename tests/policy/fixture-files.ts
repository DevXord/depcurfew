// Reads the policy fixtures: every directory in tests/fixtures/policies holds a depcurfew.json and the expected
// outcome, either resolved.json (the policy with defaults filled in) or errors.txt (one "path: message" per line).
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const POLICY_FIXTURES = new URL('../fixtures/policies/', import.meta.url);

export function policyFixtureNames(): string[] {
  return readdirSync(POLICY_FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function readFixture(name: string, file: string): string | undefined {
  const url = new URL(`${name}/${file}`, POLICY_FIXTURES);
  return existsSync(url) ? readFileSync(url, 'utf8') : undefined;
}
