// YAML merge keys (<<) and switches that turn a protection off (decision D-092): files of a tool whose loader applies
// merge keys (pnpm) are read with them, a value set where a merged one stands goes into the map itself, which wins,
// and pnpm's dangerouslyAllowAllBuilds is replaced for every value pnpm reads as true. Yarn and Dependabot files are
// read without merging.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { mergesYamlKeys, yamlOptionsFor } from '../../src/apply/facts.ts';
import { yamlGet, yamlSet, yamlSetMany } from '../../src/apply/yaml-edit.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { yamlSetting } from '../../src/doctor/settings.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { parseYamlDocument } from '../../src/yaml-parse.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const MERGE = { merge: true };
const DEFAULTS = 'packages: []\nx-defaults: &defaults\n  dangerouslyAllowAllBuilds: true\n  minimumReleaseAge: 1440\n<<: *defaults\n';

describe('which tools apply merge keys', () => {
  it('pnpm does, Yarn and Dependabot are read without them', () => {
    const tool = (id: string) => knowledgeBase.find((entry) => entry.id === id);
    expect([mergesYamlKeys(tool('pnpm')), mergesYamlKeys(tool('yarn')), mergesYamlKeys(tool('dependabot'))]).toEqual([true, false, false]);
    expect([yamlOptionsFor('pnpm-workspace.yaml'), yamlOptionsFor('.yarnrc.yml'), yamlOptionsFor('.github/dependabot.yml')]).toEqual([{ merge: true }, { merge: false }, { merge: false }]);
  });
});

describe('reading with merge keys', () => {
  it('gives merged keys, with the line that sets them and the line of the <<', () => {
    expect(yamlGet(DEFAULTS, ['dangerouslyAllowAllBuilds'], MERGE)).toBe(true);
    expect(yamlGet(DEFAULTS, ['dangerouslyAllowAllBuilds'])).toBeUndefined();
    expect(yamlSetting(DEFAULTS, ['dangerouslyAllowAllBuilds'], MERGE)).toEqual({ value: true, line: 3, mergedAt: 5 });
    expect(yamlSetting(DEFAULTS, ['dangerouslyAllowAllBuilds'])).toBeUndefined();
  });

  it('lets the keys of the map win in any order, and earlier maps of a list win over later ones', () => {
    const text = 'a: &a {k: 1}\nb: &b {k: 2, j: 3}\nk: 0\n<<: [*a, *b]\n';
    expect(yamlSetting(text, ['k'], MERGE)?.value).toBe(0);
    expect(yamlSetting(text, ['j'], MERGE)).toEqual({ value: 3, line: 2, mergedAt: 4 });
    expect(yamlSetting('a: &a {k: 1}\nb: &b {k: 2}\n<<: [*a, *b]\n', ['k'], MERGE)?.value).toBe(1);
    expect(yamlSetting('a: &a {k: 1}\n<<: *a\nk: 5\n', ['k'], MERGE)?.value).toBe(5);
  });

  it('reads a merged map as a whole, also below the top level', () => {
    const text = 'x: &x\n  esbuild: true\nallowBuilds:\n  <<: *x\n  sharp: false\n';
    expect(yamlSetting(text, ['allowBuilds'], MERGE)?.value).toEqual({ esbuild: true, sharp: false });
    expect(yamlSetting(text, ['allowBuilds', 'esbuild'], MERGE)).toEqual({ value: true, line: 2, mergedAt: 4 });
  });

  it('treats a quoted "<<" as an ordinary key and accepts several merge keys in one map', () => {
    expect(yamlGet('"<<": {k: 1}\n', ['k'], MERGE)).toBeUndefined();
    const twice = parseYamlDocument('a: &a {k: 1}\nb: &b {j: 2}\nc:\n  <<: *a\n  <<: *b\n', undefined, MERGE);
    expect(twice.errors).toEqual([]);
    expect(twice.toJS()).toMatchObject({ c: { k: 1, j: 2 } });
  });

  it('makes a merge key that does not refer to a map an error of the file, with its line', () => {
    const [error] = parseYamlDocument('a: 1\n<<: 5\n', undefined, MERGE).errors;
    expect(error?.message).toBe('the merge key << at line 2, column 1 must refer to a map or a list of maps');
    expect(parseYamlDocument('<<: *missing\n', undefined, MERGE).errors).toHaveLength(1);
    expect(parseYamlDocument('a: 1\n<<: 5\n').errors).toEqual([]);
  });
});

describe('writing where a merged key stands', () => {
  it('writes the key into the map itself, once, and leaves a merged value that is already right', () => {
    const once = yamlSet(DEFAULTS, ['dangerouslyAllowAllBuilds'], false, MERGE);
    expect(once).toBe(`${DEFAULTS}# managed by depcurfew\ndangerouslyAllowAllBuilds: false\n`);
    expect(yamlGet(once, ['dangerouslyAllowAllBuilds'], MERGE)).toBe(false);
    expect(yamlSet(once, ['dangerouslyAllowAllBuilds'], false, MERGE)).toBe(once);
    expect(yamlSet(DEFAULTS, ['minimumReleaseAge'], 1440, MERGE)).toBe(DEFAULTS);
    expect(yamlSetMany(DEFAULTS, [[['minimumReleaseAge'], 1440], [['dangerouslyAllowAllBuilds'], false]], MERGE)).toBe(once);
  });

  it('refuses to write into a map that comes in through a merge key, and says where it comes from', () => {
    const text = 'x: &x\n  allowBuilds:\n    sharp: true\n<<: *x\n';
    expect(() => yamlSet(text, ['allowBuilds', 'esbuild'], true, MERGE)).toThrow(
      'allowBuilds comes from the YAML merge key << (line 4), and depcurfew does not write into a merged map; write allowBuilds into this map itself, or set allowBuilds.esbuild to true by hand',
    );
  });
});

function pnpmRepository(workspace: string, version = '10.28.0'): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-merge-keys-'));
  temporary.push(root);
  writeFileSync(join(root, 'package.json'), `{"name": "app", "packageManager": "pnpm@${version}"}\n`);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace);
  writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "installScripts": {"default": "deny"}}\n');
  return root;
}

describe('apply and doctor with pnpm dangerouslyAllowAllBuilds', () => {
  it.each(['yes', '"true"', '"false"', '1', '"no"', '[]'])('replace dangerouslyAllowAllBuilds: %s, which pnpm reads as true', (value) => {
    const root = pnpmRepository(`dangerouslyAllowAllBuilds: ${value}\n`);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift').map((finding) => finding.level)).toEqual(['error']);
    const report = applyProject(root);
    expect(report.warningDetails.map((warning) => warning.code)).toEqual(['allow-all-replaced']);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe('# managed by depcurfew\ndangerouslyAllowAllBuilds: false\n');
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it.each(['false', '0', 'null', '""', '~'])('leave dangerouslyAllowAllBuilds: %s, which pnpm reads as off', (value) => {
    const root = pnpmRepository(`dangerouslyAllowAllBuilds: ${value}\n`);
    const report = applyProject(root);
    expect(report.warningDetails).toEqual([]);
    expect(report.changes).toEqual([]);
  });

  it('turn off dangerously-allow-all-builds of the root .npmrc in pnpm-workspace.yaml for pnpm 10, and leave the line', () => {
    const root = pnpmRepository('packages: []\n');
    writeFileSync(join(root, '.npmrc'), 'dangerously-allow-all-builds=yes\n');
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'npmrc-overrides-policy').map((finding) => finding.location)).toEqual([{ file: '.npmrc', line: 1 }]);
    const report = applyProject(root);
    expect(report.warningDetails.map((warning) => [warning.code, warning.location])).toEqual([['allow-all-replaced', { file: '.npmrc', line: 1 }]]);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe('packages: []\n# managed by depcurfew\ndangerouslyAllowAllBuilds: false\n');
    expect(readFileSync(join(root, '.npmrc'), 'utf8')).toBe('dangerously-allow-all-builds=yes\n');
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'npmrc-overrides-policy' || finding.rule === 'config-drift')).toEqual([]);
  });

  it.each([
    ['dangerously-allow-all-builds=false\n', '10.28.0'],
    ['dangerously-allow-all-builds=yes\n', '11.28.10'],
    ['dangerously-allow-all-builds=yes\n', '10.8.0'],
  ])('leave %s in .npmrc for pnpm %s, which does not run every build because of it', (npmrc, version) => {
    const root = pnpmRepository('packages: []\n', version);
    writeFileSync(join(root, '.npmrc'), npmrc);
    expect(applyProject(root).warningDetails.filter((warning) => warning.code === 'allow-all-replaced')).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'npmrc-overrides-policy')).toEqual([]);
  });

  it('do not merge in .yarnrc.yml, which Yarn reads without merge keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-merge-keys-'));
    temporary.push(root);
    writeFileSync(join(root, 'package.json'), '{"name": "app", "packageManager": "yarn@4.18.1"}\n');
    writeFileSync(join(root, '.yarnrc.yml'), 'x: &x\n  enableScripts: false\n');
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "installScripts": {"default": "deny"}}\n');
    applyProject(root);
    expect(readFileSync(join(root, '.yarnrc.yml'), 'utf8')).toBe('x: &x\n  enableScripts: false\n# managed by depcurfew\nenableScripts: false\n');
  });
});
