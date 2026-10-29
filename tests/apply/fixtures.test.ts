// "Before and after" tests: every repository in tests/fixtures/repos is copied to a temporary directory together
// with a policy (tests/fixtures/apply/policy.json unless the fixture has its own), `apply` runs, and the result is
// compared with tests/fixtures/expected/<name>/after/ (only the files that change) and apply.json (the report).
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { BLOCK_END, BLOCK_START, SUPERSEDED } from '../../src/apply/block.ts';
import { parseJsonc } from '../../src/detect/jsonc.ts';

const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../fixtures/expected/', import.meta.url));
const DEFAULT_POLICY = readFileSync(new URL('../fixtures/apply/policy.json', import.meta.url), 'utf8');

/** Settings whose values apply may change; everything else must keep its value. Lists of these are replaced. */
const MANAGED_VALUES = new Set([
  'min-release-age',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'blockExoticSubdeps',
  'dangerouslyAllowAllBuilds',
  'npmMinimalAgeGate',
  'npmPreapprovedPackages',
  'enableScripts',
  'approvedGitRepositories',
  'default-days',
  'exclude',
  'minimumDependencyAge',
  'allowScripts',
]);

const names = readdirSync(REPOS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => statSync(join(root, entry)).isFile())
    .map((entry) => entry.split(sep).join('/'))
    .sort();
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(files(root).map((file) => [file, readFileSync(join(root, file), 'latin1')]));
}

function leaves(value: unknown, path: string[] = []): [string[], unknown][] {
  if (typeof value !== 'object' || value === null) return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
}

function structured(file: string, text: string): unknown {
  if (/\.ya?ml$/u.test(file)) return parseYaml(text) as unknown;
  if (/\.jsonc?$/u.test(file)) return parseJsonc(text);
  return undefined;
}

/** Every setting present before is still there afterwards, with the same value unless depcurfew manages it. */
function expectNothingUnmanagedLost(file: string, before: string, after: string): void {
  const old = structured(file, before);
  if (old !== undefined) {
    const current = structured(file, after);
    for (const [path, value] of leaves(old)) {
      if (path.some((segment) => MANAGED_VALUES.has(segment))) continue;
      let node: unknown = current;
      for (const segment of path) node = (node as Record<string, unknown> | undefined)?.[segment];
      expect(node, `${file}: ${path.join('.')}`).toEqual(value);
    }
    return;
  }
  const lines = before.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === BLOCK_START);
  const end = lines.findIndex((line) => line.trim() === BLOCK_END);
  const outside = start === -1 ? lines : [...lines.slice(0, start), ...lines.slice(end + 1)];
  for (const line of outside) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const kept = after.includes(line) || after.includes(`${SUPERSEDED}${trimmed}`);
    expect(kept, `${file}: line "${line}" disappeared`).toBe(true);
  }
}

describe('apply on fixture repositories', () => {
  it.each(names)('%s', (name) => {
    const expectedReport = join(EXPECTED, name, 'apply.json');
    expect(existsSync(expectedReport), `${name} has an apply.json`).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), `depcurfew-apply-${name}-`));
    temporary.push(directory);
    cpSync(join(REPOS, name), directory, { recursive: true });
    const ownPolicy = join(EXPECTED, name, 'depcurfew.json');
    writeFileSync(join(directory, 'depcurfew.json'), existsSync(ownPolicy) ? readFileSync(ownPolicy, 'utf8') : DEFAULT_POLICY);
    const original = snapshot(directory);

    const report = applyProject(directory, { write: true });
    expect(report.errors).toEqual([]);
    expect({
      changed: report.changes.map((change) => change.file).sort(),
      warnings: report.warnings,
      snippets: report.snippets,
    }).toEqual(JSON.parse(readFileSync(expectedReport, 'utf8')));

    const afterDirectory = join(EXPECTED, name, 'after');
    const expectedFiles = existsSync(afterDirectory) ? files(afterDirectory) : [];
    expect(report.changes.map((change) => change.file).sort()).toEqual(expectedFiles);
    const result = snapshot(directory);
    for (const file of Object.keys(result)) {
      const expected = expectedFiles.includes(file) ? readFileSync(join(afterDirectory, file), 'latin1') : original[file];
      expect(result[file], file).toBe(expected);
    }
    for (const change of report.changes) {
      if (change.before !== null) expectNothingUnmanagedLost(change.file, change.before, change.after);
    }

    const second = applyProject(directory, { write: true });
    expect(second.changes, 'a second apply changes nothing').toEqual([]);
    expect(snapshot(directory)).toEqual(result);
  });
});
