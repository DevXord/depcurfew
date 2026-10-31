// Files from an untrusted repository cannot make doctor or apply run for minutes (CPU-time DoS found by the security
// review before 1.0.0) or end the process: many Dependabot entries, many Renovate packageRules, many continued lines in
// requirements.txt, many keys in .yarnrc.yml, and YAML nested thousands of levels deep. Before the fixes these took
// 217 s, 28 s, 288 s, 13 s and a fatal V8 error; the limits below leave a wide margin for slow CI machines.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { sameData, withValue, withValues } from '../../src/apply/expected.ts';
import { yamlSet, yamlSetMany } from '../../src/apply/yaml-edit.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { requirementsLines } from '../../src/doctor/python-lockfiles.ts';
import { MAX_YAML_DEPTH, parseYaml } from '../../src/yaml-parse.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, sources: { git: 'deny', remoteTarball: 'deny' }, targets: 'auto' });

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-cpu-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries({ 'depcurfew.json': POLICY, ...files })) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

function seconds(action: () => void): number {
  const start = performance.now();
  action();
  return (performance.now() - start) / 1000;
}

const entry = '  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    cooldown: {default-days: 1}\n';

describe('many edits of one YAML file', () => {
  it('plans a dependabot.yml with 500 entries in seconds, in doctor and apply', { timeout: 120_000 }, () => {
    const root = repository({ 'package.json': '{}', '.github/dependabot.yml': `version: 2\nupdates:\n${entry.repeat(500)}` });
    let findings: ReturnType<typeof runDoctor>['findings'] = [];
    expect(seconds(() => (findings = runDoctor(root).findings))).toBeLessThan(10);
    expect(findings.filter((finding) => finding.rule === 'config-drift' && finding.location.file === '.github/dependabot.yml')).toHaveLength(1);
    let after = '';
    expect(seconds(() => (after = applyProject(root, { write: false }).changes.find((change) => change.file === '.github/dependabot.yml')?.after ?? ''))).toBeLessThan(10);
    expect(after.match(/default-days: 3/gu)).toHaveLength(500);
  });

  // The edits of a batch are made on the text before them and checked together; the result must be what yamlSet
  // gives one edit after another, comments and markers included.
  it.each([
    ['flow cooldowns', `version: 2\nupdates:\n${entry.repeat(3)}`, [0, 1, 2].map((index) => [['updates', index, 'cooldown', 'default-days'], 3] as const)],
    [
      'block entries without cooldown, with comments',
      'version: 2\nupdates:\n  # npm\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily # every day\n  - package-ecosystem: pip\n    directory: /py\n    # ignore nothing\n    ignore: []\n',
      [
        [['updates', 0, 'cooldown'], { 'default-days': 3, exclude: ['@acme/*'] }],
        [['updates', 1, 'cooldown'], { 'default-days': 3 }],
      ],
    ],
    [
      'several keys of one block cooldown',
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    cooldown:\n      default-days: 1\n      semver-major-days: 1\n      exclude: [a]\n',
      [
        [['updates', 0, 'cooldown', 'default-days'], 3],
        [['updates', 0, 'cooldown', 'semver-major-days'], 3],
        [['updates', 0, 'cooldown', 'exclude'], ['@acme/*', 'left-pad']],
      ],
    ],
    ['a scalar where a map is needed, then a key in it', 'version: 2\nupdates:\n  - package-ecosystem: npm\n    cooldown: 1\n', [[['updates', 0, 'cooldown', 'default-days'], 3], [['updates', 0, 'cooldown', 'exclude'], ['x']]]],
    ['the same path twice', 'a: 1\n', [[['a'], 2], [['a'], 3]]],
  ] as const)('gives the same text as yamlSet one by one: %s', (_name, text, edits) => {
    const sequential = edits.reduce((current, [path, value]) => yamlSet(current, path, value), text);
    expect(yamlSetMany(text, edits)).toBe(sequential);
  });

  it('refuses an edit as yamlSet refuses it', () => {
    const text = 'updates: [{package-ecosystem: npm}]\n';
    expect(() => yamlSetMany(text, [[['updates', 0, 'cooldown'], { 'default-days': 3 }]])).toThrow(/flow style/u);
  });

  it('builds the expected data as withValue one after another does', () => {
    const data = { list: [{ a: 1 }, 'x', [1]], scalar: 1, nested: { deep: { value: 1 } } };
    const edits = [
      { path: ['list', 0, 'a'], value: 2 },
      { path: ['list', 1, 'b'], value: 3 },
      { path: ['list', 2, 'key'], value: 4 },
      { path: ['scalar', 'x'], value: 5 },
      { path: ['nested', 'deep'], value: [6] },
      { path: ['__proto__', 'polluted'], value: true },
      { path: ['new', 0], value: 7 },
    ];
    const folded = edits.reduce<unknown>((current, edit) => withValue(current, edit.path, edit.value), data);
    expect(sameData(withValues(data, edits), folded)).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('many Renovate packageRules', () => {
  it('reads a renovate.json with 4000 packageRules in seconds', { timeout: 120_000 }, () => {
    const rules = Array.from({ length: 4000 }, () => '{"matchPackageNames":["!a"]}').join(',\n');
    const root = repository({ 'package.json': '{"packageManager":"npm@11.19.1"}', 'renovate.json': `{"packageRules":[\n${rules}\n]}` });
    expect(seconds(() => runDoctor(root))).toBeLessThan(10);
  });
});

describe('many continued lines in requirements.txt', () => {
  it('joins 250 000 continued lines in seconds', { timeout: 120_000 }, () => {
    const root = repository({ 'requirements.txt': `${'a \\\n'.repeat(250_000)}b\n` });
    expect(seconds(() => runDoctor(root))).toBeLessThan(10);
  });

  it('joins continuations as before', () => {
    // The joining before the fix (a growing text), as the reference for small inputs.
    const before = (input: string): { text: string; line: number }[] => {
      const lines = input.split(/\r?\n/u);
      const result: { text: string; line: number }[] = [];
      for (let index = 0; index < lines.length; index++) {
        const start = index;
        let line = (lines[index] ?? '').replace(/(^|\s)#.*$/u, '');
        while (line.trimEnd().endsWith('\\') && index + 1 < lines.length) {
          index += 1;
          line = `${line.trimEnd().slice(0, -1)} ${(lines[index] ?? '').replace(/(^|\s)#.*$/u, '')}`;
        }
        if (line.trim() !== '') result.push({ text: line.trim(), line: start + 1 });
      }
      return result;
    };
    const format = { comment: '#', continuation: '\\' };
    for (const input of ['a \\\n  b # note\nc \\\n   \nd\n\\\ne\nf \\\\\n\n', 'x \\\\\\\n\n\n\ny\n', '-r a.txt \\\r\n --hash=sha256:x \\\r\n', ' \\\n\\\n', 'a\\']) {
      expect(requirementsLines(input, format), JSON.stringify(input)).toEqual(before(input));
    }
  });
});

describe('many keys in .yarnrc.yml', () => {
  it('reads a .yarnrc.yml with 16 000 keys in seconds', { timeout: 120_000 }, () => {
    const keys = Array.from({ length: 16_000 }, (_, index) => `k${index}: v`).join('\n');
    const root = repository({ 'package.json': '{"packageManager":"yarn@4.12.0"}', '.yarnrc.yml': `${keys}\n` });
    expect(seconds(() => runDoctor(root))).toBeLessThan(15);
  });
});

describe('YAML nested very deep', () => {
  it.each([
    ['flow sequences', `a: ${'['.repeat(100_000)}${']'.repeat(100_000)}\n`, 1],
    ['flow maps', `a: ${'{a: '.repeat(100_000)}1${'}'.repeat(100_000)}\n`, 1],
    ['compact sequence items', `a:\n  ${'- '.repeat(100_000)}x\n`, 2],
    ['block maps', Array.from({ length: 1000 }, (_, index) => `${' '.repeat(index)}k${index}:`).join('\n') + '\n', 257],
  ])('reports %s as a file depcurfew cannot read, without ending the process', (_name, text, line) => {
    const root = repository({ 'package.json': '{"packageManager":"pnpm@10.26.0"}', 'pnpm-workspace.yaml': text });
    const findings = runDoctor(root).findings.filter((finding) => finding.rule === 'unreadable-config' && finding.location.file === 'pnpm-workspace.yaml');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(new RegExp(`^cannot parse pnpm-workspace\\.yaml: collections are nested more than ${MAX_YAML_DEPTH} levels deep at line ${line}, column \\d+, deeper than depcurfew parses; depcurfew cannot check it$`, 'u'));
  });

  it('parses YAML nested up to the limit, and brackets in quotes, comments and block scalars do not count', () => {
    const depth = MAX_YAML_DEPTH - 1;
    expect(() => parseYaml(`a: ${'['.repeat(depth)}${']'.repeat(depth)}\n`)).not.toThrow();
    const brackets = '['.repeat(1000);
    expect(parseYaml(`a: "${brackets}"\nb: '${brackets}' # ${brackets}\nc: |\n  ${brackets}\n  "${brackets}\nd: ${brackets.replaceAll('[', 'x[')}\n`)).toMatchObject({ a: brackets, c: `${brackets}\n"${brackets}\n` });
  });
});
