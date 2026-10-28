// Every repository in tests/fixtures/repos has its expected detection in tests/fixtures/expected/<name>/detect.json.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';

const REPOS = new URL('../fixtures/repos/', import.meta.url);
const EXPECTED = new URL('../fixtures/expected/', import.meta.url);

const names = readdirSync(REPOS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('project detection on fixture repositories', () => {
  it('has at least ten fixtures', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it.each(names)('%s', (name) => {
    const expected: unknown = JSON.parse(readFileSync(new URL(`${name}/detect.json`, EXPECTED), 'utf8'));
    expect(detectProject(fileURLToPath(new URL(name, REPOS)))).toEqual(expected);
  });

  it.each(names)('%s gives the same result twice (deterministic)', (name) => {
    const root = fileURLToPath(new URL(name, REPOS));
    expect(JSON.stringify(detectProject(root))).toBe(JSON.stringify(detectProject(root)));
  });
});
