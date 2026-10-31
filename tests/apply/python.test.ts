// apply on Python projects: what uv records in uv.lock, and the [tool.pdm.resolution] table PDM checks pdm.lock against,
// has to be locked again after a change; poetry.lock and Pipfile.lock do not cover what apply writes.
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

function project(files: Record<string, string>, policy: object): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-python-'));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return root;
}

const PDM_PYPROJECT = '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["requests==2.32.3"]\n\n[tool.pdm]\ndistribution = false\n';
const PDM_LOCK = '[metadata]\ngroups = ["default"]\nstrategy = ["inherit_metadata"]\nlock_version = "4.5.0"\ncontent_hash = "sha256:0000"\n';

describe('apply on PDM, Poetry and Pipenv projects', () => {
  it('says to lock again when the [tool.pdm.resolution] table PDM checks pdm.lock against changes, and only then', () => {
    const root = project({ 'pyproject.toml': PDM_PYPROJECT, 'pdm.lock': PDM_LOCK }, { cooldown: { minimum: '3d' }, installScripts: { default: 'deny' } });
    expect(relock(applyProject(root).warningDetails)).toEqual([
      'PDM: pdm.lock is checked against the whole [tool.pdm.resolution] table, and this change alters exclude-newer and only-binary, so pdm.lock is out of date. Run pdm lock and commit pdm.lock; until then pdm lock --check and pdm install --check fail',
    ]);
    expect(applyProject(root).warningDetails.find((warning) => warning.code === 'lockfile-out-of-date')).toBeUndefined();
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '5d' }, installScripts: { default: 'deny' } }));
    const warning = applyProject(root).warningDetails.find((entry) => entry.code === 'lockfile-out-of-date');
    expect(warning).toEqual({
      code: 'lockfile-out-of-date',
      tool: 'pdm',
      location: { file: 'pdm.lock' },
      message: 'PDM: pdm.lock is checked against the whole [tool.pdm.resolution] table, and this change alters exclude-newer, so pdm.lock is out of date',
      fix: 'Run pdm lock and commit pdm.lock; until then pdm lock --check and pdm install --check fail',
    });
  });

  it('counts the build settings too, and says nothing without a pdm.lock or when the values stay the same', () => {
    const builds = project({ 'pyproject.toml': PDM_PYPROJECT, 'pdm.lock': PDM_LOCK }, { installScripts: { default: 'deny', allow: ['pypi:docopt'] } });
    expect(relock(applyProject(builds).warningDetails)).toEqual([
      'PDM: pdm.lock is checked against the whole [tool.pdm.resolution] table, and this change alters only-binary and no-binary, so pdm.lock is out of date. Run pdm lock and commit pdm.lock; until then pdm lock --check and pdm install --check fail',
    ]);
    expect(relock(applyProject(project({ 'pyproject.toml': PDM_PYPROJECT }, { cooldown: { minimum: '3d' } })).warningDetails)).toEqual([]);
    const same = project({ 'pyproject.toml': `${PDM_PYPROJECT}\n[tool.pdm.resolution]\nexclude-newer = "3d"\n`, 'pdm.lock': PDM_LOCK }, { cooldown: { minimum: '3d' } });
    expect(relock(applyProject(same).warningDetails)).toEqual([]);
  });

  it('says nothing about locking again for Poetry and Pipenv, whose lockfiles do not cover what apply writes', () => {
    const poetry = project(
      {
        'pyproject.toml': '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["requests (==2.32.3)"]\n\n[tool.poetry]\npackage-mode = false\n',
        'poetry.lock': '[metadata]\nlock-version = "2.1"\npython-versions = ">=3.12"\ncontent-hash = "0000"\n',
      },
      { cooldown: { minimum: '3d' }, installScripts: { default: 'deny' } },
    );
    const poetryReport = applyProject(poetry);
    expect(poetryReport.changes.map((change) => change.file)).toEqual(['poetry.toml']);
    expect(relock(poetryReport.warningDetails)).toEqual([]);
    const pipenv = project(
      {
        Pipfile: '[[source]]\nurl = "https://pypi.org/simple"\nverify_ssl = true\nname = "pypi"\n\n[packages]\nrequests = "==2.32.3"\n',
        'Pipfile.lock': '{"_meta": {"hash": {"sha256": "0000"}, "pipfile-spec": 6, "requires": {}, "sources": []}, "default": {}, "develop": {}}\n',
      },
      { cooldown: { minimum: '3d' } },
    );
    const pipenvReport = applyProject(pipenv);
    expect(pipenvReport.changes.map((change) => change.file)).toEqual(['Pipfile']);
    expect(relock(pipenvReport.warningDetails)).toEqual([]);
  });
});
