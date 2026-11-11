// Decision D-200: the regular expressions that read repository files run in linear time, and no regular expression is
// built from a pattern of the repository that could backtrack for minutes. A crafted renovate.json, uv.toml,
// bunfig.toml, pylock.toml, requirements.txt, composer.lock, depcurfew.json, dependabot.yml or workflow made doctor,
// apply, explain and the GitHub Action run for seconds to hours (found by the review of 1.6.0, already in 1.6.0): each
// case below took between 6 s and 70 s of CPU time for its first command before the change, and the Dependabot glob
// and the Renovate patterns did not finish within 30 s on the built 1.6.0. A Renovate /regex/ depcurfew does not run
// counts as matching where its rule shortens or turns off the delay, so the rule is reported, as 1.6.0 reported it.
// The limits are CPU time of this process (D-188).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAction } from '../../src/action.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { run } from '../../src/cli/run.ts';
import { markdown } from '../../src/doctor/github.ts';
import { cpuNow } from '../support/cpu-time.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d200-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function cli(argv: string[]): Promise<string> {
  let output = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-11T12:00:00Z'),
    stdin: () => Promise.resolve(''),
  };
  await run(argv, { stdout: (text) => (output += text), stderr: (text) => (output += text) }, dependencies);
  return output;
}

/** CPU seconds of `action` (tests/support/cpu-time.ts). */
async function seconds(action: () => unknown): Promise<number> {
  const start = cpuNow();
  await action();
  return (cpuNow() - start) / 1000;
}

/** doctor --json, doctor --sarif, apply --dry-run --json, explain --json and the Action: each within `limit` CPU seconds. */
async function quick(root: string, limit = 2): Promise<string> {
  let doctor = '';
  for (const argv of [['doctor', '--json', root], ['doctor', '--sarif', root], ['apply', '--dry-run', '--json', root], ['explain', '--json', root]]) {
    let output = '';
    expect(await seconds(async () => (output = await cli(argv))), argv.join(' ')).toBeLessThan(limit);
    if (argv[1] === '--json' && argv[0] === 'doctor') doctor = output;
  }
  expect(await seconds(() => runAction({ GITHUB_WORKSPACE: root }, { log: () => {}, summary: () => {} })), 'the Action').toBeLessThan(limit);
  return doctor;
}

interface Finding {
  rule: string;
  level: string;
  message: string;
  fix: string;
  location: { file: string; line?: number };
}

const PACKAGE = JSON.stringify({ name: 'app', version: '1.0.0' });
const POLICY = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, sources: { git: 'deny', remoteTarball: 'deny', file: 'deny', directory: 'deny' }, ...extra });

describe('repository text read in linear time (decision D-200)', () => {
  it('a renovate.json minimumReleaseAge of many digits that is no duration', async () => {
    const root = repository({ 'package.json': PACKAGE, 'depcurfew.json': POLICY(), 'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: `${'1'.repeat(30_000)}!` }) });
    await quick(root);
  });

  it('a renovate.json extends entry with many opening brackets', async () => {
    const root = repository({ 'package.json': PACKAGE, 'depcurfew.json': POLICY(), 'renovate.json': JSON.stringify({ extends: ['config:recommended', `x${'('.repeat(40_000)}`] }) });
    await quick(root);
  });

  it('a uv.toml exclude-newer of many digits that is no duration', async () => {
    const root = repository({
      'pyproject.toml': '[project]\nname = "app"\nversion = "1.0.0"\n',
      'uv.toml': `exclude-newer = "${'1'.repeat(80_000)}!"\n`,
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });

  it('a bunfig.toml value with many blanks inside', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'bun@1.3.0' }),
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {}\n}\n',
      'bunfig.toml': `[install]\nminimumReleaseAge = "3${' '.repeat(120_000)}days"\n`,
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });

  it('a pylock.toml directory path of many slashes', async () => {
    const root = repository({
      'pyproject.toml': '[project]\nname = "app"\nversion = "1.0.0"\n',
      'pylock.toml': `lock-version = "1.0"\ncreated-by = "test"\n\n[[packages]]\nname = "local"\n\n[packages.directory]\npath = "${'/'.repeat(200_000)}x"\n`,
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });

  it('a requirements.txt requirement followed by many blanks', async () => {
    const root = repository({ 'requirements.txt': `requests==2.32.3${' '.repeat(200_000)}x\n`, 'depcurfew.json': POLICY() });
    await quick(root);
    // And without depcurfew.json, where doctor checks with its default policy.
    const bare = repository({ 'requirements.txt': `requests==2.32.3${' '.repeat(200_000)}x\n` });
    expect(await seconds(() => cli(['doctor', '--json', bare]))).toBeLessThan(2);
  });

  it('a composer.lock source url ending in many slashes', async () => {
    const lock = {
      packages: [{ name: 'acme/lib', version: '1.0.0', source: { type: 'git', url: `https://github.com/acme/lib${'/'.repeat(200_000)}x`, reference: 'a'.repeat(40) } }],
      'packages-dev': [],
    };
    const root = repository({
      'composer.json': JSON.stringify({ name: 'acme/app', require: { 'acme/lib': '1.0.0' } }),
      'composer.lock': JSON.stringify(lock),
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });

  it('a projects entry of depcurfew.json with many slashes', async () => {
    const root = repository({ 'package.json': PACKAGE, 'depcurfew.json': POLICY({ projects: [`/a${'/'.repeat(80_000)}x`] }) });
    const doctor = await quick(root);
    expect(doctor).toContain('must be relative to the repository root');
  });

  it('a dependabot.yml line of many ":#" pairs', async () => {
    const root = repository({
      'package.json': PACKAGE,
      'depcurfew.json': POLICY(),
      '.github/dependabot.yml': `version: 2\nx-note: "${':#'.repeat(80_000)}"\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n`,
    });
    await quick(root);
  });

  it('a workflow that runs bundle with a version selector of many blanks', async () => {
    const step = `bundle _${' '.repeat(200_000)}x_ install`;
    const root = repository({
      Gemfile: "source 'https://rubygems.org'\ngem 'rake'\n",
      'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.3.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rake\n\nBUNDLED WITH\n   4.0.12\n',
      '.github/workflows/ci.yml': `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${step}\n`,
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });

  it('markdown for the job summary of a text with a long run of blanks', async () => {
    for (const text of [`a${' '.repeat(200_000)}b`, `a${' '.repeat(200_000)}\nb`, `${'\t  '.repeat(100_000)}x`]) {
      let shown = '';
      expect(await seconds(() => (shown = markdown(text)))).toBeLessThan(0.5);
      expect(shown.length).toBeGreaterThan(0);
    }
  });
});

describe('patterns of the repository are not run as regular expressions that backtrack (decision D-200)', () => {
  it('a Dependabot directories glob with many stars, against projects', async () => {
    const name = 'a'.repeat(60);
    const root = repository({
      'depcurfew.json': POLICY({ projects: [name, 'b'] }),
      [`${name}/package.json`]: PACKAGE,
      'b/package.json': PACKAGE,
      '.github/dependabot.yml': `version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directories: ["/b", "/*a*a*a*a*a*a*a*a*c"]\n    schedule:\n      interval: "weekly"\n`,
    });
    const doctor = await quick(root);
    // The glob does not match the long project, as before: Dependabot does not update it.
    expect(doctor).toContain(`has no updates entry with package-ecosystem: npm for ${name}`);
  });

  const WORKFLOW = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n';
  for (const [label, pattern, reason] of [
    ['a quantified group', '/(a|aa)*z/', 'a quantified group'],
    ['many optional parts', `/${'[ab]?'.repeat(30)}c/`, 'more than 256 ways to match (each ?, {n,m} and | multiplies them)'],
    ['alternatives one after the other', `/${'(?:a|a)'.repeat(30)}b/`, 'more than 256 ways to match (each ?, {n,m} and | multiplies them)'],
    ['two unbounded quantifiers', '/a*a*b/', 'more than one unbounded quantifier (*, + or {n,})'],
    ['an unbounded quantifier and many ways to match', '/.*[ab]{0,255}c/', 'an unbounded quantifier (*, + or {n,}) and more than 16 ways to match (each ?, {n,m} and | multiplies them)'],
  ] as const) {
    it(`a Renovate matchFileNames regex with ${label} is not run, and counts as matching in a rule that shortens the delay`, async () => {
      const root = repository({
        'package.json': PACKAGE,
        'depcurfew.json': POLICY(),
        'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: '3 days', packageRules: [{ matchFileNames: [pattern], minimumReleaseAge: '1 day' }] }),
        [`.github/workflows/${'a'.repeat(200)}.yml`]: WORKFLOW,
      });
      const doctor = await quick(root);
      const findings = (JSON.parse(doctor) as { findings: Finding[] }).findings;
      const found = findings.find((finding) => finding.rule === 'bot-cooldown-mismatch' && finding.message.includes('packageRules[0]'));
      expect(found).toMatchObject({ level: 'error', location: { file: 'renovate.json', line: 1 } });
      expect(found?.message).toContain(`counting matchFileNames ${JSON.stringify(pattern)} as matching`);
      expect(found?.fix).toContain(`depcurfew does not run ${JSON.stringify(pattern)} in matchFileNames: it has ${reason},`);
    });
  }

  it('a Renovate regex depcurfew does not run gives a note when the rule may shorten the delay but does not shorten the one before it', async () => {
    const root = repository({
      'package.json': PACKAGE,
      'depcurfew.json': POLICY(),
      'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: '1 day', packageRules: [{ matchFileNames: ['/(a|aa)*z/'], minimumReleaseAge: '2 days' }] }),
      '.github/workflows/ci.yml': WORKFLOW,
    });
    const findings = (JSON.parse(await quick(root)) as { findings: Finding[] }).findings;
    const note = findings.find((finding) => finding.message.includes('packageRules[0]') && finding.message.includes('which depcurfew cannot read'));
    expect(note).toMatchObject({ rule: 'bot-cooldown-mismatch', level: 'note', location: { file: 'renovate.json', line: 1 } });
    expect(note?.fix).toContain('depcurfew does not run "/(a|aa)*z/" in matchFileNames: it has a quantified group,');
    // The top-level delay is the shorter one, and is reported as before.
    expect(findings.some((finding) => finding.level === 'error' && finding.message.includes('minimumReleaseAge: "1 day" in renovate.json'))).toBe(true);
  });

  it('a Renovate regex depcurfew reads still counts', async () => {
    const root = repository({
      'package.json': PACKAGE,
      'depcurfew.json': POLICY(),
      'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: '3 days', packageRules: [{ matchFileNames: ['/^\\.github\\/workflows\\/.*\\.ya?ml$/'], minimumReleaseAge: '1 day' }] }),
      '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n',
    });
    const findings = (JSON.parse(await quick(root)) as { findings: { message: string }[] }).findings;
    expect(findings.some((finding) => finding.message.includes('which depcurfew cannot read'))).toBe(false);
    expect(findings.some((finding) => finding.message.includes('packageRules[0] of renovate.json'))).toBe(true);
  });

  it('a Renovate configuration of 600 rules with an unbounded quantifier and many ways to match', async () => {
    // Before, 200 such rules made doctor run for 15 s against a workflow named with 200 letters.
    const rules = Array.from({ length: 600 }, (_, index) => ({ matchFileNames: [`/.*[ab]{0,${index + 16}}c/`], minimumReleaseAge: '1 day' }));
    const root = repository({
      'package.json': PACKAGE,
      'depcurfew.json': POLICY(),
      'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: '3 days', packageRules: rules }),
      [`.github/workflows/${'a'.repeat(200)}.yml`]: WORKFLOW,
    });
    const findings = (JSON.parse(await quick(root)) as { findings: Finding[] }).findings;
    const found = findings.find((finding) => finding.rule === 'bot-cooldown-mismatch' && finding.level === 'error');
    expect(found?.fix).toContain('depcurfew does not run "/.*[ab]{0,16}c/" in matchFileNames: it has an unbounded quantifier');
  });

  it('a Renovate configuration of 1,000 rules with costly /regex/ patterns that depcurfew runs one by one', async () => {
    // Each pattern takes milliseconds against a long file name, and together seconds for each command: depcurfew
    // stops running the /regex/ patterns of one file after a fixed amount of work.
    const rules = Array.from({ length: 1_000 }, (_, index) => ({ matchFileNames: [`/.*${'.'.repeat(200)}c${index}/`], minimumReleaseAge: '1 day' }));
    const root = repository({
      'package.json': PACKAGE,
      'depcurfew.json': POLICY(),
      'renovate.json': JSON.stringify({ extends: ['config:recommended'], minimumReleaseAge: '3 days', packageRules: rules }),
      [`.github/workflows/${'a'.repeat(200)}.yml`]: WORKFLOW,
    });
    const findings = (JSON.parse(await quick(root)) as { findings: Finding[] }).findings;
    const found = findings.find((finding) => finding.rule === 'bot-cooldown-mismatch' && finding.level === 'error');
    expect(found?.message).toContain('as matching');
    expect(found?.fix).toContain('it stops running the /regex/ patterns of a Renovate file after a fixed amount of work');
  });

  it('a Dependabot directories glob of 1 MiB of stars, against 100 projects', async () => {
    const names = Array.from({ length: 100 }, (_, index) => `p${index}${'a'.repeat(100)}`);
    const glob = `/${'*'.repeat(1024 * 1024 - 400)}z`;
    const root = repository({
      'depcurfew.json': POLICY({ projects: [...names, 'b'] }),
      ...Object.fromEntries(names.map((name) => [`${name}/package.json`, PACKAGE])),
      'b/package.json': PACKAGE,
      '.github/dependabot.yml': `version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directories: ["/b", "${glob}"]\n    schedule:\n      interval: "weekly"\n`,
    });
    let doctor = '';
    expect(await seconds(async () => (doctor = await cli(['doctor', '--json', root])))).toBeLessThan(4);
    expect(doctor).toContain(`has no updates entry with package-ecosystem: npm for ${names[0]}`);
  });
});

describe('a Renovate /regex/ that depcurfew does not run counts in the direction that reports (decision D-200)', () => {
  const NPM = {
    'package.json': JSON.stringify({ name: 'app', private: true, packageManager: 'npm@12.2.1' }),
    'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n',
    '.npmrc': 'min-release-age=3\n',
  };
  const renovate = (rules: unknown[]) => `${JSON.stringify({ minimumReleaseAge: '3 days', packageRules: rules }, null, 2)}\n`;
  const doctorFindings = async (root: string) => (JSON.parse(await cli(['doctor', '--json', root])) as { findings: Finding[] }).findings;

  it('a rule that shortens the delay for a datasource matched by such a regex gives bot-cooldown-mismatch, and apply warns', async () => {
    const rules = [{ matchDatasources: ['/^(?:npm)+$/'], minimumReleaseAge: '1 day' }];
    const root = repository({ ...NPM, 'renovate.json': renovate(rules) });
    const found = (await doctorFindings(root)).find((finding) => finding.rule === 'bot-cooldown-mismatch');
    expect(found).toMatchObject({ level: 'error', location: { file: 'renovate.json', line: 4 } });
    expect(found?.message).toContain('counting matchDatasources "/^(?:npm)+$/" as matching');
    expect(found?.fix).toContain('Make minimumReleaseAge in packageRules[0] of renovate.json at least 3 days');
    expect(found?.fix).toContain('depcurfew does not run "/^(?:npm)+$/" in matchDatasources: it has a quantified group,');

    const policy = repository({ ...NPM, 'renovate.json': renovate(rules), 'depcurfew.json': POLICY() });
    const apply = JSON.parse(await cli(['apply', '--dry-run', '--json', policy])) as { warnings: (Finding & { code: string })[] };
    const warning = apply.warnings.find((item) => item.code === 'bot-rule-shortens-delay');
    expect(warning).toMatchObject({ level: 'warning', location: { file: 'renovate.json', line: 4 } });
    expect(warning?.message).toContain('counting matchDatasources "/^(?:npm)+$/" as matching');
    expect(warning?.fix).toContain('depcurfew does not run "/^(?:npm)+$/" in matchDatasources: it has a quantified group,');
  });

  it('a rule that turns the delay off for a datasource matched by such a regex gives broad-exclusion', async () => {
    const root = repository({ ...NPM, 'renovate.json': renovate([{ matchDatasources: ['/^(?:npm)+$/'], minimumReleaseAge: null }]) });
    const found = (await doctorFindings(root)).find((finding) => finding.rule === 'broad-exclusion');
    expect(found).toMatchObject({ level: 'error', location: { file: 'renovate.json', line: 4 } });
    expect(found?.message).toContain('packageRules[0] turns off minimumReleaseAge for every package from the npm datasource');
    expect(found?.message).toContain('counting matchDatasources "/^(?:npm)+$/" as matching');
    expect(found?.fix).toContain('depcurfew does not run "/^(?:npm)+$/" in matchDatasources: it has a quantified group,');
  });

  it('a rule that turns the delay off for some names of a datasource matched by such a regex gives broad-exclusion', async () => {
    const root = repository({
      ...NPM,
      'depcurfew.json': POLICY(),
      'renovate.json': renovate([{ matchPackageNames: ['left-pad'], matchDatasources: ['/^(?:npm)+$/'], minimumReleaseAge: null }]),
    });
    const found = (await doctorFindings(root)).find((finding) => finding.rule === 'broad-exclusion');
    expect(found).toMatchObject({ level: 'error', location: { file: 'renovate.json', line: 4 } });
    expect(found?.message).toContain('packageRules[0] in renovate.json turns off minimumReleaseAge for "left-pad" (npm packages, counting matchDatasources "/^(?:npm)+$/" as matching');
    expect(found?.fix).toContain('depcurfew does not run "/^(?:npm)+$/" in matchDatasources: it has a quantified group,');
  });

  it('the note names the regex only when it is what depcurfew cannot read', async () => {
    // The negative glob {a,b} is what depcurfew cannot read here: rewriting the regex would not take the note away.
    const root = repository({ ...NPM, 'renovate.json': renovate([{ matchDatasources: ['/^(?:npm)+$/', '!{a,b}'], minimumReleaseAge: '1 day' }]) });
    const note = (await doctorFindings(root)).find((finding) => finding.rule === 'bot-cooldown-mismatch');
    expect(note).toMatchObject({ level: 'note', location: { file: 'renovate.json', line: 4 } });
    expect(note?.fix).not.toContain('depcurfew does not run');
    expect(note?.fix).toContain('write its matchDatasources with names, * or /regex/ patterns, which depcurfew reads');
  });
});

describe('secrets in the diff of a long line (decision D-200)', () => {
  it('a .yarnrc.yml npmAuthToken of many blanks and a line separator', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'yarn@4.12.0' }),
      'yarn.lock': '__metadata:\n  version: 8\n',
      '.yarnrc.yml': `npmAuthToken: ${' '.repeat(40_000)}x\u2028y\n`,
      'depcurfew.json': POLICY(),
    });
    await quick(root);
  });
});
