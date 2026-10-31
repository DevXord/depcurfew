// apply warns when the project installs a newer depcurfew than the one running (depcurfew-outdated): an older
// copy may not know settings the project's version writes.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { isNewerThanRunning, projectCopy } from '../../src/self-version.ts';
import { Repository } from '../../src/detect/repository.ts';

const OUTDATED = fileURLToPath(new URL('../fixtures/doctor/depcurfew-outdated/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(fixture: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-self-version-'));
  temporary.push(directory);
  cpSync(join(OUTDATED, fixture, 'repo'), directory, { recursive: true });
  writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm"] }\n');
  return directory;
}

async function applyJson(directory: string): Promise<{ warnings: { code: string; location?: unknown; message: string; fix?: string }[] }> {
  let stdout = '';
  await run(['apply', '--dry-run', '--json', directory], { stdout: (text) => (stdout += text), stderr: () => undefined });
  return JSON.parse(stdout) as { warnings: { code: string; location?: unknown; message: string; fix?: string }[] };
}

describe('depcurfew-outdated in apply', () => {
  it('warns, with the file and line, when package-lock.json pins a newer depcurfew', async () => {
    const report = await applyJson(project('fires-package-lock'));
    expect(report.warnings.filter((warning) => warning.code === 'depcurfew-outdated')).toEqual([
      {
        code: 'depcurfew-outdated',
        level: 'warning',
        location: { file: 'package-lock.json', line: 12 },
        message: 'depcurfew 99.0.0 is pinned in package-lock.json (line 12), but the depcurfew running apply is older, so it may not know settings that version writes',
        fix: "Install the project's dependencies (npm ci), then run its copy (npx depcurfew apply), or update the depcurfew you run to 99.0.0 or later",
      },
    ]);
  });

  it('names the installed copy, with its line, when node_modules has one', async () => {
    const directory = project('fires-package-lock');
    mkdirSync(join(directory, 'node_modules', 'depcurfew'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'depcurfew', 'package.json'), '{\n  "name": "depcurfew",\n  "version": "99.0.0"\n}\n');
    const report = await applyJson(directory);
    expect(report.warnings.find((warning) => warning.code === 'depcurfew-outdated')).toMatchObject({
      location: { file: 'node_modules/depcurfew/package.json', line: 3 },
      message: 'depcurfew 99.0.0 is installed in the project (node_modules/depcurfew/package.json, line 3), but the depcurfew running apply is older, so it may not know settings that version writes',
      fix: "Run the project's copy (npx depcurfew apply), or update the depcurfew you run to 99.0.0 or later",
    });
  });

  it('stays quiet when the project pins an older depcurfew or none', async () => {
    for (const fixture of ['passes-older-copy', 'passes-not-installed']) {
      const report = await applyJson(project(fixture));
      expect(report.warnings.map((warning) => warning.code)).not.toContain('depcurfew-outdated');
    }
  });

  it('prefers the copy in node_modules, which is what the project runs', () => {
    const directory = project('fires-package-lock');
    mkdirSync(join(directory, 'node_modules', 'depcurfew'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'depcurfew', 'package.json'), '{\n  "name": "depcurfew",\n  "version": "98.1.0-rc.1"\n}\n');
    const copy = projectCopy(new Repository(directory));
    expect(copy).toEqual({ version: '98.1.0-rc.1', file: 'node_modules/depcurfew/package.json', line: 3 });
    expect(isNewerThanRunning(copy!, '98.1.0')).toBe(false);
    expect(isNewerThanRunning(copy!, '98.0.9')).toBe(true);
  });
});
