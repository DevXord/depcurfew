// Update bots against what the repository already sets (decision D-171): a Renovate preset that shortens the delay
// apply writes, Dependabot cooldown.include and a broad cooldown.exclude apply keeps, the Renovate rule for npm
// exclusions limited to the npm datasource, Dependabot exclusions Psych would read as booleans, and Renovate rules that
// exempt packages cooldown.exclude does not. No network; every directory is removed afterwards.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { applyProject } from '../src/apply/index.ts';
import { yamlGet, yamlSet } from '../src/apply/yaml-edit.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { psychScalar, psychReadsAsString } from '../src/yaml-parse.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>, policy?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d171-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  if (policy !== undefined) writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }, null, 2));
  return root;
}

const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
type Warning = { code: string; location?: { file: string; line?: number }; message: string; fix?: string };
const warnings = (report: { warningDetails: Warning[] }, code: string) => report.warningDetails.filter((warning) => warning.code === code);
const codes = (report: { warningDetails: Warning[] }) => report.warningDetails.map((warning) => warning.code).filter((code) => code !== 'version-not-pinned');
const problems = (root: string) => runDoctor(root).findings.filter((finding) => finding.level !== 'note');
const rulesOf = (root: string, file = 'renovate.json') => (JSON.parse(read(root, file)) as { packageRules?: Record<string, unknown>[] }).packageRules ?? [];

const NPM = { 'package.json': '{\n  "name": "app",\n  "packageManager": "npm@11.17.0"\n}\n' };
const CARGO = { 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nuuid = "1"\n', 'Cargo.lock': 'version = 4\n' };
const UV = { 'pyproject.toml': '[project]\nname = "app"\nversion = "0.1.0"\ndependencies = []\n\n[tool.uv]\nrequired-version = "==0.13.6"\n', 'uv.lock': 'version = 1\n' };
const restore = (datasource: string, value: string) => ({
  description: `depcurfew: minimumReleaseAge for the ${datasource} datasource over a preset's shorter delay`,
  matchDatasources: [datasource],
  matchUpdateTypes: ['major', 'minor', 'patch'],
  minimumReleaseAge: value,
});

describe('a Renovate preset that shortens the delay apply writes (A2, P5)', () => {
  it('config:best-practices: apply writes a rule for the npm datasource after the preset, and doctor finds nothing', () => {
    const root = repository({ ...NPM, 'renovate.json': '{\n  "extends": ["config:best-practices"]\n}\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    const report = applyProject(root);
    const renovate = JSON.parse(read(root, 'renovate.json')) as Record<string, unknown>;
    expect(renovate['minimumReleaseAge']).toBe('7 days');
    expect(renovate['packageRules']).toEqual([restore('npm', '7 days')]);
    expect(codes(report)).not.toContain('bot-rule-shortens-delay');
    expect(problems(root)).toEqual([]);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('security:minimumReleaseAgeCrate with Cargo (decision D-151) gets a rule for the crate datasource', () => {
    const root = repository({ ...CARGO, 'renovate.json': '{\n  "extends": ["security:minimumReleaseAgeCrate"]\n}\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    applyProject(root);
    expect(rulesOf(root)).toEqual([restore('crate', '7 days')]);
    expect(problems(root)).toEqual([]);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('security:minimumReleaseAgePypi with uv gets a rule for the pypi datasource; no rule for a datasource the repository does not use', () => {
    const root = repository({ ...UV, 'renovate.json': '{\n  "extends": ["config:best-practices", "security:minimumReleaseAgePypi"]\n}\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    applyProject(root);
    // config:best-practices delays npm packages, which this repository does not have.
    expect(rulesOf(root)).toEqual([restore('pypi', '7 days')]);
    expect(problems(root).filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });

  it('puts the rule before the rules of the repository and before the exclusion rule, and moves it back to the front', () => {
    const own = { description: 'Our packages', matchPackageNames: ['@acme/*'], minimumReleaseAge: null };
    const root = repository(
      { ...NPM, 'renovate.json': `${JSON.stringify({ extends: ['config:best-practices'], packageRules: [own] }, null, 2)}\n` },
      { cooldown: { minimum: '7d', exclude: ['@acme/*', 'left-pad'] }, targets: 'auto' },
    );
    applyProject(root);
    const rules = rulesOf(root);
    expect(rules.map((rule) => rule['description'])).toEqual([restore('npm', '7 days').description, 'Our packages', 'depcurfew: packages excluded from minimumReleaseAge']);
    expect(rules[2]).toEqual({ description: 'depcurfew: packages excluded from minimumReleaseAge', matchDatasources: ['npm'], matchPackageNames: ['@acme/*', 'left-pad'], minimumReleaseAge: null });
    expect(problems(root)).toEqual([]);
    // A rule moved to the end would win over the exceptions after it: apply moves it back.
    writeFileSync(join(root, 'renovate.json'), `${JSON.stringify({ extends: ['config:best-practices'], minimumReleaseAge: '7 days', packageRules: [own, rules[2], rules[0]] }, null, 2)}\n`);
    applyProject(root);
    expect(rulesOf(root).map((rule) => rule['description'])).toEqual([restore('npm', '7 days').description, 'Our packages', 'depcurfew: packages excluded from minimumReleaseAge']);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('keeps the comments of renovate.jsonc with the rules they stand above, and an inline list on one line', () => {
    const jsonc = '{\n  // shared settings\n  "extends": ["config:best-practices"],\n  "packageRules": [\n    // eslint goes in by itself\n    { "matchPackageNames": ["eslint"], "automerge": true }\n  ]\n}\n';
    const root = repository({ ...NPM, 'renovate.jsonc': jsonc }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    applyProject(root);
    const text = read(root, 'renovate.jsonc');
    expect(text).toContain('  "packageRules": [\n    {\n      "description": "depcurfew: minimumReleaseAge for the npm datasource over a preset\'s shorter delay",');
    expect(text).toContain('"minimumReleaseAge": "7 days"\n    },\n    // eslint goes in by itself\n    { "matchPackageNames": ["eslint"], "automerge": true }\n  ]');
    expect(applyProject(root).changes).toEqual([]);
    const inline = repository({ ...NPM, 'renovate.json': '{ "extends": ["config:best-practices"], "packageRules": [{ "matchPackageNames": ["eslint"], "automerge": true }] }\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    applyProject(inline);
    expect(read(inline, 'renovate.json')).toContain(
      '"packageRules": [{ "description": "depcurfew: minimumReleaseAge for the npm datasource over a preset\'s shorter delay", "matchDatasources": [ "npm" ], "matchUpdateTypes": [ "major", "minor", "patch" ], "minimumReleaseAge": "7 days" }, { "matchPackageNames": ["eslint"], "automerge": true }]',
    );
  });

  it('writes no rule when the preset waits as long as the policy or longer, and removes it when the preset goes', () => {
    const root = repository({ ...NPM, 'renovate.json': '{\n  "extends": ["config:best-practices"]\n}\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    applyProject(root);
    expect(rulesOf(root)).toHaveLength(1);
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, targets: 'auto' }));
    applyProject(root);
    expect(rulesOf(root)).toEqual([]);
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '7d' }, targets: 'auto' }));
    applyProject(root);
    const config = JSON.parse(read(root, 'renovate.json')) as Record<string, unknown>;
    writeFileSync(join(root, 'renovate.json'), `${JSON.stringify({ ...config, extends: ['config:recommended'] }, null, 2)}\n`);
    applyProject(root);
    expect(rulesOf(root)).toEqual([]);
  });

  it('a shorter rule of the repository is still reported, with its index and line in the file apply leaves', () => {
    const root = repository(
      { ...NPM, 'renovate.json': `${JSON.stringify({ extends: ['config:best-practices'], packageRules: [{ matchDatasources: ['npm'], minimumReleaseAge: '1 day' }] }, null, 2)}\n` },
      { cooldown: { minimum: '7d' }, targets: 'auto' },
    );
    const report = applyProject(root);
    // The rule apply writes is packageRules[0]; the one of the repository now starts on the line of its "{".
    const lines = read(root, 'renovate.json').split('\n');
    let start = lines.findIndex((entry) => entry.includes('"1 day"'));
    while (start > 0 && lines[start]?.trim() !== '{') start -= 1;
    expect(warnings(report, 'bot-rule-shortens-delay')).toEqual([
      {
        code: 'bot-rule-shortens-delay',
        tool: 'renovate',
        location: { file: 'renovate.json', line: start + 1 },
        message: `Renovate: packageRules[1] in renovate.json (line ${start + 1}) sets minimumReleaseAge: "1 day" for updates of npm packages, shorter than the 1 week depcurfew apply writes for Renovate; Renovate uses the rule, and depcurfew apply does not change entries it did not write`,
        fix: 'Make minimumReleaseAge in packageRules[1] of renovate.json at least 1 week, or limit the rule to the packages that need a shorter delay',
      },
    ]);
    expect(lines.findIndex((entry) => entry.includes('over a preset'))).toBeLessThan(start);
  });

  it('the snippet for the deprecated package.json key has the rule too', () => {
    const root = repository(
      { 'package.json': `${JSON.stringify({ name: 'app', packageManager: 'npm@11.17.0', renovate: { extends: ['config:best-practices'] } }, null, 2)}\n` },
      { cooldown: { minimum: '7d' }, targets: 'auto' },
    );
    const report = applyProject(root);
    const snippet = report.snippets.find((entry) => entry.file === 'package.json');
    expect(JSON.parse(snippet?.text ?? '{}')).toEqual({ minimumReleaseAge: '7 days', packageRules: [restore('npm', '7 days')], vulnerabilityAlerts: { minimumReleaseAge: null } });
  });

  it("doctor's fix names the rule to add, and sends to apply only where apply edits the file", () => {
    const npmrc = { '.npmrc': 'min-release-age=7\n' };
    const editable = repository({ ...NPM, ...npmrc, 'renovate.json': '{\n  "extends": ["config:best-practices"],\n  "minimumReleaseAge": "7 days"\n}\n' }, { cooldown: { minimum: '7d' }, targets: 'auto' });
    const [finding] = problems(editable).filter((entry) => entry.rule === 'bot-cooldown-mismatch');
    expect(finding?.fix).toBe(
      'Add a packageRules entry with matchDatasources ["npm"] and a minimumReleaseAge of at least 1 week to renovate.json, which Renovate applies after the rules of the preset config:best-practices, or run depcurfew apply, which adds one',
    );
    const deprecated = repository(
      { ...npmrc, 'package.json': `${JSON.stringify({ name: 'app', packageManager: 'npm@11.17.0', renovate: { extends: ['config:best-practices'], minimumReleaseAge: '7 days' } }, null, 2)}\n` },
      { cooldown: { minimum: '7d' }, targets: 'auto' },
    );
    const [other] = problems(deprecated).filter((entry) => entry.rule === 'bot-cooldown-mismatch');
    expect(other?.fix).toBe(
      'Add a packageRules entry with matchDatasources ["npm"] and a minimumReleaseAge of at least 1 week to package.json (depcurfew apply does not edit it); Renovate applies it after the rules of the preset config:best-practices',
    );
    expect(other?.fix).not.toMatch(/run depcurfew apply/u);
  });
});

describe('Dependabot cooldown.include and a broad cooldown.exclude apply keeps (A3)', () => {
  const dependabot = (entry: string) => `version: 2\nupdates:\n${entry}`;

  it('warns about an include list in an entry apply writes default-days into', () => {
    const root = repository(
      { ...NPM, '.github/dependabot.yml': dependabot('  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 5\n      include:\n        - react\n') },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    const report = applyProject(root);
    expect(warnings(report, 'bot-rule-shortens-delay')).toEqual([
      {
        code: 'bot-rule-shortens-delay',
        tool: 'dependabot',
        location: { file: '.github/dependabot.yml', line: 10 },
        message:
          'Dependabot: cooldown.include in updates[0] (npm) of .github/dependabot.yml (line 10) names only react, so the cooldown depcurfew apply writes there covers only these dependencies, and Dependabot proposes updates of every other dependency of the entry without waiting',
        fix: 'Remove include from the cooldown of updates[0] in .github/dependabot.yml, so that the cooldown covers every dependency, and list the dependencies that need no delay in cooldown.exclude in depcurfew.json',
      },
    ]);
    // cooldown-shortened says what the 5 days covered.
    expect(warnings(report, 'cooldown-shortened')[0]?.message).toContain('waits 5 days for npm updates of react,');
    expect(applyProject(root).warningDetails.map((warning) => warning.code)).toContain('bot-rule-shortens-delay');
  });

  it('gives no warning for include: ["*"]', () => {
    const root = repository(
      { ...NPM, '.github/dependabot.yml': dependabot('  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 3\n      include:\n        - "*"\n') },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    expect(codes(applyProject(root))).not.toContain('bot-rule-shortens-delay');
  });

  it('a cargo entry with exclude: ["*"] (decision D-151): a warning, and no cooldown-shortened about a delay Dependabot never had', () => {
    const root = repository(
      { ...CARGO, '.github/dependabot.yml': dependabot('  - package-ecosystem: cargo\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 7\n      exclude: ["*"]\n') },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    const report = applyProject(root);
    expect(read(root, '.github/dependabot.yml')).toContain('default-days: 3\n      exclude: ["*"]');
    // Cargo is a package manager since E06, with the limits of its own delay since E07; its crates have no names in
    // the policy, so the entry keeps its own exclude list (E08).
    expect(codes(report)).toEqual(['cooldown-limits', 'bot-rule-shortens-delay']);
    expect(warnings(report, 'bot-rule-shortens-delay')[0]).toEqual({
      code: 'bot-rule-shortens-delay',
      tool: 'dependabot',
      location: { file: '.github/dependabot.yml', line: 10 },
      message:
        'Dependabot: cooldown.exclude in updates[0] (cargo) of .github/dependabot.yml (line 10) contains "*", so Dependabot applies no cooldown to these updates, the one depcurfew apply writes included; depcurfew apply keeps this list, because cooldown.exclude in depcurfew.json names no Rust crates',
      fix: 'Remove "*" from cooldown.exclude in updates[0] of .github/dependabot.yml and list only the dependencies that need the exception',
    });
    expect(problems(root).map((finding) => finding.rule)).toEqual(['broad-exclusion']);
  });

  it('a github-actions entry with exclude: ["*"] gets the warning too', () => {
    const root = repository(
      {
        ...NPM,
        '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
        '.github/dependabot.yml': dependabot(
          '  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      exclude: ["*"]\n',
        ),
      },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    const [warning] = warnings(applyProject(root), 'bot-rule-shortens-delay');
    expect(warning?.message).toBe(
      'Dependabot: cooldown.exclude in updates[1] (github-actions) of .github/dependabot.yml (line 15) contains "*", so Dependabot applies no cooldown to these updates, the one depcurfew apply writes included; depcurfew apply keeps this list, because cooldown.exclude in depcurfew.json names no actions',
    );
  });
});

describe('the Renovate rule for npm exclusions is limited to the npm datasource (A11)', () => {
  it('matchDatasources: ["npm"], also next to Cargo, whose crates of the same name keep their delay', () => {
    const root = repository({ ...NPM, ...CARGO, 'renovate.json': '{}\n' }, { cooldown: { minimum: '3d', exclude: ['uuid'] }, targets: 'auto' });
    applyProject(root);
    expect(rulesOf(root)).toEqual([{ description: 'depcurfew: packages excluded from minimumReleaseAge', matchDatasources: ['npm'], matchPackageNames: ['uuid'], minimumReleaseAge: null }]);
    expect(problems(root)).toEqual([]);
  });

  it('the Python and Composer rules stay limited to pypi and packagist', () => {
    const root = repository({ ...NPM, ...UV, 'renovate.json': '{}\n' }, { cooldown: { minimum: '3d', exclude: ['uuid', 'pypi:requests'] }, targets: 'auto' });
    applyProject(root);
    expect(rulesOf(root).map((rule) => rule['matchDatasources'])).toEqual([['npm'], ['pypi']]);
  });

  it('doctor reports the rule an earlier apply wrote without the npm datasource', () => {
    const old = { description: 'depcurfew: packages excluded from minimumReleaseAge', matchPackageNames: ['uuid'], minimumReleaseAge: null };
    for (const rule of [old, { ...old, matchDatasources: ['!pypi', '!packagist', '!rubygems'] }]) {
      const root = repository(
        { ...NPM, ...CARGO, 'renovate.json': `${JSON.stringify({ minimumReleaseAge: '3 days', vulnerabilityAlerts: { minimumReleaseAge: null }, packageRules: [rule] }, null, 2)}\n` },
        { cooldown: { minimum: '3d', exclude: ['uuid'] }, targets: 'auto' },
      );
      const findings = runDoctor(root).findings.filter((finding) => finding.rule === 'broad-exclusion');
      expect(findings).toEqual([
        {
          rule: 'broad-exclusion',
          level: 'error',
          location: { file: 'renovate.json', line: 7 },
          message:
            'packageRules[0] in renovate.json, the rule depcurfew apply writes for the npm names of cooldown.exclude in depcurfew.json, is not limited to matchDatasources ["npm"], so it also turns off minimumReleaseAge for packages of the same names from other datasources, Rust packages among them',
          fix: 'Run depcurfew apply, which limits the rule to matchDatasources ["npm"]',
        },
      ]);
    }
  });
});

describe('the rules in the deprecated package.json key, which apply does not edit', () => {
  it("doctor's fixes do not send to apply, but to the snippet it prints", () => {
    const old = { description: 'depcurfew: packages excluded from minimumReleaseAge', matchPackageNames: ['uuid'], minimumReleaseAge: null };
    const root = repository(
      { ...CARGO, 'package.json': `${JSON.stringify({ name: 'app', packageManager: 'npm@11.17.0', renovate: { minimumReleaseAge: '3 days', packageRules: [old, { matchPackageNames: ['@acme/*'], minimumReleaseAge: null }] } }, null, 2)}\n` },
      { cooldown: { minimum: '3d', exclude: ['uuid'] }, targets: 'auto' },
    );
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'broad-exclusion').map((finding) => finding.fix)).toEqual([
      'Add matchDatasources: ["npm"] to packageRules[0] of package.json, as the snippet of depcurfew apply shows it (depcurfew apply does not edit package.json)',
      'Add "@acme/*" to cooldown.exclude in depcurfew.json if these packages need no delay (depcurfew apply then shows in a snippet the rule for them), or remove the exception from packageRules[1] of package.json',
    ]);
  });
});

describe('Dependabot exclusions that Psych would read as something else (A4)', () => {
  const NAMES = ['yes', 'no', 'on', 'off', 'Yes', 'OFF', 'tRUE', 'nUll', '1_0', '0b1', '2024-01-01', 'react'];

  it('writes them quoted, so that YAML 1.1 and Psych read the names', () => {
    const root = repository(
      { ...NPM, '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n' },
      { cooldown: { minimum: '3d', exclude: NAMES }, targets: 'auto' },
    );
    applyProject(root);
    const text = read(root, '.github/dependabot.yml');
    const yaml11 = parseYaml(text, { version: '1.1' }) as { updates: { cooldown: { exclude: unknown[] } }[] };
    expect(yaml11.updates[0]?.cooldown.exclude).toEqual(NAMES);
    expect(yamlGet(text, ['updates', 0, 'cooldown', 'exclude'], { psychScalars: true })).toEqual(NAMES);
    // Names Psych reads as names stay unquoted.
    expect(text).toContain('- react\n');
    expect(applyProject(root).changes).toEqual([]);
  });

  it('reads plain booleans and nulls as Psych 5.5.0 does, so the check of an edit catches them', () => {
    expect(['yes', 'Yes', 'YES', 'on', 'true', 'tRUE'].map(psychScalar)).toEqual(Array(6).fill({ kind: 'boolean', value: true }));
    expect(['no', 'NO', 'off', 'Off', 'false'].map(psychScalar)).toEqual(Array(5).fill({ kind: 'boolean', value: false }));
    expect(['~', 'null', 'nUll', 'NULL'].map(psychScalar)).toEqual(Array(4).fill({ kind: 'null' }));
    expect(['y', 'n', 'yesterday', 'nope', 'onion', 'react'].map(psychScalar)).toEqual(Array(6).fill({ kind: 'other' }));
    expect(yamlGet('a: yes\nb: Off\nc: nUll\nd: "yes"\ne: react\n', [], { psychScalars: true })).toEqual({ a: true, b: false, c: null, d: 'yes', e: 'react' });
    // A plain yes in the file is true for Dependabot, not the name yes: setting the name changes the value.
    expect(yamlSet('exclude:\n  - yes\n', ['exclude'], ['yes'], { psychScalars: true })).toBe('# managed by depcurfew\nexclude:\n  - "yes"\n');
  });

  it('knows which plain scalars Psych reads as the same string', () => {
    for (const text of ['react', '@types/node', 'y', 'yesterday', 'left-pad', 'a.b', '1e3', '08', '0o12']) expect(psychReadsAsString(text), text).toBe(true);
    for (const text of ['', 'yes', 'No', 'ON', '~', 'nULL', '010', '1_0', '1,0', '0x1f', '1:30', '1.5', '.inf', '-.INF', '.NaN', ':sym', '2024-01-01', '2024-01-01 10:00:00'])
      expect(psychReadsAsString(text), text).toBe(false);
  });
});

describe('a Renovate rule that exempts packages cooldown.exclude does not (P8)', () => {
  const renovate = (rules: object[]) => `${JSON.stringify({ minimumReleaseAge: '3 days', vulnerabilityAlerts: { minimumReleaseAge: null }, packageRules: rules }, null, 2)}\n`;

  it('reports a scope the policy does not exempt, at the line of the rule', () => {
    const root = repository({ ...NPM, '.npmrc': 'min-release-age=3\n', 'renovate.json': renovate([{ matchPackageNames: ['@acme/*'], minimumReleaseAge: null }]) }, { cooldown: { minimum: '3d', exclude: [] }, targets: 'auto' });
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'broad-exclusion')).toEqual([
      {
        rule: 'broad-exclusion',
        level: 'error',
        location: { file: 'renovate.json', line: 7 },
        message: 'packageRules[0] in renovate.json turns off minimumReleaseAge for "@acme/*" (npm packages), which cooldown.exclude in depcurfew.json does not exempt',
        fix: 'Add "@acme/*" to cooldown.exclude in depcurfew.json if these packages need no delay (depcurfew apply then writes the rule for them), or remove the exception from packageRules[0] of renovate.json',
      },
    ]);
  });

  it('says nothing when the policy exempts the names, or the rule reaches no registry the policy names', () => {
    const exempt = repository({ ...NPM, 'renovate.json': renovate([{ matchPackageNames: ['@acme/ui', '@ACME/core', '@acme/ui-*'], minimumReleaseAge: null }]) }, { cooldown: { minimum: '3d', exclude: ['@acme/*'] }, targets: 'auto' });
    expect(runDoctor(exempt).findings.filter((finding) => finding.rule === 'broad-exclusion')).toEqual([]);
    const docker = repository({ ...NPM, 'renovate.json': renovate([{ matchDatasources: ['docker'], matchPackageNames: ['node'], minimumReleaseAge: null }]) }, { cooldown: { minimum: '3d' }, targets: 'auto' });
    expect(runDoctor(docker).findings.filter((finding) => finding.rule === 'broad-exclusion')).toEqual([]);
    // The policy names no crates: their exceptions stay the repository's own, as in Dependabot (decision D-152).
    const crates = repository({ ...NPM, ...CARGO, 'renovate.json': renovate([{ matchDatasources: ['crate'], matchPackageNames: ['serde'], minimumReleaseAge: null }]) }, { cooldown: { minimum: '3d' }, targets: 'auto' });
    expect(runDoctor(crates).findings.filter((finding) => finding.rule === 'broad-exclusion')).toEqual([]);
    const longer = repository({ ...NPM, 'renovate.json': renovate([{ matchPackageNames: ['react'], minimumReleaseAge: '5 days' }]) }, { cooldown: { minimum: '3d' }, targets: 'auto' });
    expect(runDoctor(longer).findings.filter((finding) => finding.rule === 'broad-exclusion')).toEqual([]);
  });

  it('reports a shorter delay, a rule that reaches two registries, and a Python name with the prefix the policy needs', () => {
    const root = repository(
      { ...NPM, ...UV, 'renovate.json': renovate([{ matchPackageNames: ['react'], matchUpdateTypes: ['major'], minimumReleaseAge: '1 day' }, { matchDatasources: ['pypi'], matchPackageNames: ['requests'], minimumReleaseAge: null }]) },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    const findings = runDoctor(root).findings.filter((finding) => finding.rule === 'broad-exclusion');
    expect(findings.map((finding) => [finding.location.line, finding.message, finding.fix])).toEqual([
      [
        7,
        // Without matchDatasources the rule matches a Python package named react as well.
        'packageRules[0] in renovate.json sets minimumReleaseAge: "1 day" for major updates of "react" (npm and Python packages), shorter than cooldown.minimum "3d" in depcurfew.json, which cooldown.exclude does not exempt them from',
        'Add "react" and "pypi:react" to cooldown.exclude in depcurfew.json if these packages need no delay (depcurfew apply then writes the rules for them), limit packageRules[0] of renovate.json with matchDatasources to the registry it is meant for, or remove the exception from it',
      ],
      [
        16,
        'packageRules[1] in renovate.json turns off minimumReleaseAge for "requests" (Python packages), which cooldown.exclude in depcurfew.json does not exempt',
        'Add "pypi:requests" to cooldown.exclude in depcurfew.json if these packages need no delay (depcurfew apply then writes the rule for them), or remove the exception from packageRules[1] of renovate.json',
      ],
    ]);
  });
});
