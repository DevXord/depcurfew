// doctor right after apply: on every fixture repository, no file differs from the policy (config-drift errors),
// and no rule throws. Allow-list entries the fixtures already had stay, so config-drift may still warn about them.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../fixtures/expected/', import.meta.url));
const POLICY = readFileSync(new URL('../fixtures/apply/policy.json', import.meta.url), 'utf8');

const names = readdirSync(REPOS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('doctor after apply', () => {
  it.each(names)('%s', (name) => {
    const directory = mkdtempSync(join(tmpdir(), `depcurfew-doctor-${name}-`));
    temporary.push(directory);
    cpSync(join(REPOS, name), directory, { recursive: true });
    let policy = POLICY;
    try {
      policy = readFileSync(join(EXPECTED, name, 'depcurfew.json'), 'utf8');
    } catch {
      // the shared policy
    }
    writeFileSync(join(directory, 'depcurfew.json'), policy);
    applyProject(directory, { write: true });
    const report = runDoctor(directory);
    expect(report.findings.filter((finding) => finding.rule === 'config-drift' && finding.level === 'error')).toEqual([]);
  });

  it.each(names)('doctor runs on %s without a policy', (name) => {
    expect(() => runDoctor(join(REPOS, name))).not.toThrow();
  });
});
