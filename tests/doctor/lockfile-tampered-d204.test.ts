// lockfile-tampered (decision D-204): composer.lock gives a package a transport option that Composer calls as a PHP
// function while it downloads (prevent_url_access_callable from 2.10.0-RC2, GHSA-jhfp-4ppm-crmm, and
// prevent_ip_access_callable from 2.7.3; Composer 2.11.2 no longer takes them from composer.lock), or composer.json gives
// one to a repository or to a package a package repository defines. It is a fact of the files: an error with or without
// depcurfew.json, once, and in the projects depcurfew init would list too. composerEntries sets the field only on the
// entries that have such a key, and no other composer.lock of the fixtures gets the finding. The fixtures hold the
// harmless value "strlen".
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import { composerEntries } from '../../src/doctor/composer.ts';
import { RULES, runDoctor, type DoctorReport, type Finding } from '../../src/doctor/index.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const RULE_FIXTURES = join(FIXTURES, 'doctor', 'lockfile-tampered');
const composer = knowledgeBase.find((tool) => tool.id === 'composer') as ToolKnowledge;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function copy(name: string, into?: string): string {
  const root = into ?? mkdtempSync(join(tmpdir(), 'depcurfew-d204-'));
  if (into === undefined) temporary.push(root);
  cpSync(join(RULE_FIXTURES, name, 'repo'), root, { recursive: true });
  return root;
}

const expected = (name: string) => JSON.parse(readFileSync(join(RULE_FIXTURES, name, 'expected.json'), 'utf8')) as Omit<Finding, 'rule'>[];

/** A fetch that fails the test when doctor asks anything. */
const never: FetchLike = async (url) => {
  throw new Error(`doctor asked ${url}`);
};

async function doctor(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(['doctor', ...argv], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch: never, now: () => new Date(), stdin: async () => '', osvData: () => undefined });
  return { code, stdout };
}

const tampered = (report: DoctorReport) => report.findings.filter((finding) => finding.rule === 'lockfile-tampered');
const withoutRule = (findings: readonly Finding[]) => findings.map(({ rule: _rule, ...finding }) => finding);

describe('lockfile-tampered without depcurfew.json', () => {
  it('reports each key once, as an error that fails doctor, not as a note against the default policy', async () => {
    const root = copy('fires-composer-transport-callable');
    expect(existsSync(join(root, 'depcurfew.json'))).toBe(false);
    const result = await doctor('--json', root);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(withoutRule(tampered(report))).toEqual(expected('fires-composer-transport-callable'));
    expect(report.checked?.rules.find((entry) => entry.rule === 'lockfile-tampered')).toEqual({
      rule: 'lockfile-tampered',
      check: 'No package of composer.lock and no repository of composer.json has a transport option that Composer calls as a PHP function',
      result: 'problems',
      errors: 2,
      warnings: 0,
      notes: 0,
    });
  });

  it('keeps the level in SARIF and in the text', async () => {
    const root = copy('fires-composer-transport-callable');
    const sarif = JSON.parse((await doctor('--sarif', root)).stdout) as { runs: { results: { ruleId: string; level: string; properties?: unknown }[] }[] };
    const results = sarif.runs[0]?.results.filter((result) => result.ruleId === 'lockfile-tampered') ?? [];
    expect(results.map((result) => [result.level, result.properties])).toEqual([
      ['error', undefined],
      ['error', undefined],
    ]);
    const text = (await doctor(root)).stdout;
    expect(text.match(/prevent_url_access_callable, which/gu)).toHaveLength(1);
    expect(text).toMatch(/^ {2}10: error composer\.lock gives monolog\/monolog the transport option prevent_url_access_callable, /mu);
    // Not among the notes against the default policy.
    const compared = text.slice(text.indexOf('Compared with the default policy'), text.indexOf('Notes:'));
    expect(compared).not.toContain('(lockfile-tampered)');
  });

  it('reports a tampered composer.lock in a project that depcurfew init would list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-d204-projects-'));
    temporary.push(root);
    mkdirSync(join(root, 'shop'));
    copy('fires-composer-transport-callable', join(root, 'shop'));
    mkdirSync(join(root, 'web'));
    writeFileSync(join(root, 'web', 'package.json'), '{ "name": "web", "version": "1.0.0" }\n');
    const result = await doctor('--json', root);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(tampered(report).map((finding) => [finding.level, finding.location, finding.policy])).toEqual([
      ['error', { file: 'shop/composer.lock', line: 10 }, undefined],
      ['error', { file: 'shop/composer.lock', line: 59 }, undefined],
    ]);
    expect(report.checked?.rules.find((entry) => entry.rule === 'lockfile-tampered')).toMatchObject({ result: 'problems', errors: 2 });
  });
});

describe('lockfile-tampered with depcurfew.json', () => {
  it('gives the same errors', () => {
    const root = copy('fires-composer-repositories-options-callable');
    writeFileSync(join(root, 'depcurfew.json'), '{ "version": 1 }\n');
    expect(withoutRule(tampered(runDoctor(root)))).toEqual(expected('fires-composer-repositories-options-callable'));
  });

  it('names a package that is no Composer package name by its line in the fix', () => {
    const root = copy('fires-composer-transport-callable');
    const lockfile = join(root, 'composer.lock');
    writeFileSync(lockfile, readFileSync(lockfile, 'utf8').replace('"name": "monolog/monolog"', '"name": "Mono Log; rm"'));
    const [finding] = tampered(runDoctor(root));
    expect(finding?.message).toContain('composer.lock gives mono log; rm the transport option prevent_url_access_callable');
    expect(finding?.fix).toContain('remove prevent_url_access_callable from the transport-options of the package at line 10 of composer.lock');
  });
});

describe('composerEntries and transport options (decision D-204)', () => {
  const lock = (packages: object[], dev: object[] = []) => JSON.stringify({ packages, 'packages-dev': dev });
  const dist = { type: 'zip', url: 'https://api.github.com/repos/a/b/zipball/abc', reference: 'abc', shasum: '' };

  it('sets transportCallables on an entry that sets a callable key to anything but null, as PHP isset reads it', () => {
    const entries = composerEntries(
      lock(
        [
          { name: 'a/url', version: '1.0.0', type: 'library', dist, 'transport-options': { prevent_url_access_callable: 'strlen', relative: true } },
          { name: 'a/both', version: '1.0.0', type: 'library', dist, 'transport-options': { prevent_ip_access_callable: ['A', 'b'], prevent_url_access_callable: false } },
          { name: 'a/null', version: '1.0.0', type: 'library', dist, 'transport-options': { prevent_url_access_callable: null } },
          { name: 'a/list', version: '1.0.0', type: 'library', dist, 'transport-options': ['prevent_url_access_callable'] },
          { name: 'a/case', version: '1.0.0', type: 'library', dist, 'transport-options': { Prevent_Url_Access_Callable: 'strlen', http: { prevent_url_access_callable: 'strlen' } } },
        ],
        [{ name: 'a/dev', version: '1.0.0', type: 'library', dist, 'transport-options': { prevent_ip_access_callable: 'strlen' } }],
      ),
      composer,
      [],
    );
    expect(entries.map((entry) => [entry.name, entry.transportCallables])).toEqual([
      ['a/url', ['prevent_url_access_callable']],
      ['a/both', ['prevent_url_access_callable', 'prevent_ip_access_callable']],
      ['a/null', undefined],
      ['a/list', undefined],
      ['a/case', undefined],
      ['a/dev', ['prevent_ip_access_callable']],
    ]);
  });

  it('leaves the field out of a clean entry, also of one with the transport options of a path repository', () => {
    const [entry] = composerEntries(lock([{ name: 'a/local', version: 'dev-main', type: 'library', dist: { type: 'path', url: 'packages/local' }, 'transport-options': { relative: true, symlink: false } }]), composer, []);
    expect(entry).toEqual({ name: 'a/local', spec: 'path packages/local', source: 'directory', installScript: false, anchor: '"name": "a/local"' });
  });
});

describe('lockfile-tampered on the other fixtures', () => {
  const rule = RULES.find((entry) => entry.id === 'lockfile-tampered');

  /** Every directory of tests/fixtures with a composer.lock or a composer.json, except the fires-* fixtures of the rule. */
  function composerDirectories(directory: string, found: string[] = []): string[] {
    const names = readdirSync(directory);
    if ((names.includes('composer.lock') || names.includes('composer.json')) && !relative(RULE_FIXTURES, directory).split(sep)[0]?.startsWith('fires')) found.push(directory);
    for (const name of names) {
      const path = join(directory, name);
      if (name !== 'node_modules' && statSync(path).isDirectory()) composerDirectories(path, found);
    }
    return found;
  }

  it('finds nothing in a composer.lock or composer.json that no one tampered with', () => {
    expect(rule).toBeDefined();
    const directories = composerDirectories(FIXTURES);
    expect(directories.length).toBeGreaterThan(10);
    for (const directory of directories) {
      const report = runDoctor(directory, { rules: rule === undefined ? [] : [rule], invalidPolicy: 'report' });
      expect(report.findings, relative(FIXTURES, directory)).toEqual([]);
    }
  });
});
