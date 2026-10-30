// apply on Python projects: what uv records in uv.lock has to be locked again after a change.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { warningText, type ApplyWarning } from '../../src/apply/warnings.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function uvProject(policy: object, lock = true): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-uv-'));
  temporary.push(root);
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n\n[tool.uv]\nrequired-version = "==0.13.6"\n');
  if (lock) writeFileSync(join(root, 'uv.lock'), 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n');
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return root;
}

const relock = (warnings: readonly ApplyWarning[]) => warnings.filter((warning) => warning.code === 'lockfile-out-of-date').map(warningText);

describe('apply on uv projects', () => {
  it('says to lock again when a setting uv records in uv.lock changes, and only then', () => {
    const root = uvProject({ cooldown: { minimum: '3d', exclude: ['pypi:certifi'] } });
    expect(relock(applyProject(root).warningDetails)).toEqual([
      'uv: uv.lock records exclude-newer and exclude-newer-package, so it is out of date after this change. Run uv lock and commit uv.lock; until then uv sync --locked and uv lock --check fail',
    ]);
    expect(relock(applyProject(root).warningDetails)).toEqual([]);
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '5d', exclude: ['pypi:certifi'] } }));
    expect(relock(applyProject(root).warningDetails)).toEqual([
      'uv: uv.lock records exclude-newer, so it is out of date after this change. Run uv lock and commit uv.lock; until then uv sync --locked and uv lock --check fail',
    ]);
  });

  it('says nothing about uv lock for settings uv.lock does not record or apply leaves alone, or without a uv.lock', () => {
    expect(relock(applyProject(uvProject({ installScripts: { default: 'deny' } })).warningDetails)).toEqual([]);
    const own = uvProject({ installScripts: { default: 'deny' } });
    writeFileSync(join(own, 'uv.toml'), 'exclude-newer = "1 week"\n');
    expect(relock(applyProject(own).warningDetails)).toEqual([]);
    expect(relock(applyProject(uvProject({ cooldown: { minimum: '3d' } }, false)).warningDetails)).toEqual([]);
  });
});
