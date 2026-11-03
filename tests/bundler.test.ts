// Bundler (decision D-152): the source calls of a Gemfile as apply reads and edits them, detection of the Bundler
// version (BUNDLED WITH, ruby/setup-ruby, gem install bundler) and of bundle commands, apply's warnings for what Bundler
// cannot do, the bots' entries for gems, and doctor's checks of the version and the variables that weaken the cooldown.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gemfileIn, gemfileSources, sameServer, setSourceCooldown } from '../src/apply/gemfile.ts';
import { applyProject } from '../src/apply/index.ts';
import { findToolCommands } from '../src/detect/commands.ts';
import { detectProject } from '../src/detect/index.ts';
import { detectionFacts } from '../src/detect/knowledge.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { readSetting } from '../src/doctor/settings.ts';
import { Repository } from '../src/detect/repository.ts';
import { environment } from '../src/knowledge/environment.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';
import { parsePolicy } from '../src/policy/validate.ts';
import { EXIT_OK, run } from '../src/cli/run.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A repository in a temporary directory with the files given, removed after the test. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-bundler-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const POLICY = (minimum: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, cooldown: { minimum }, ...extra });
const LOCK = (version: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.2.3)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n\nBUNDLED WITH\n   ${version}\n`;

describe('the source calls of a Gemfile', () => {
  it('reads plain calls, their cooldown and the forms apply does not edit', () => {
    const text = [
      'source "https://rubygems.org"',
      "source('https://rubygems.org/', cooldown: 7) # reviewed",
      'source "https://rubygems.org", :cooldown => 2',
      'source "https://gems.example.com", cooldown: 0 do',
      'end',
      'source "https://rubygems.org", cooldown: ENV.fetch("DAYS").to_i',
      'source "https://#{HOST}"',
      'source "https://rubygems.org",',
      '  cooldown: 3',
      'source = "https://rubygems.org"',
      'gem "x", source: "https://rubygems.org"',
      '# source "https://rubygems.org"',
    ].join('\n');
    expect(gemfileSources(text)).toEqual([
      { line: 1, url: 'https://rubygems.org', plain: true, block: false },
      { line: 2, url: 'https://rubygems.org/', cooldown: 7, plain: true, block: false },
      { line: 3, url: 'https://rubygems.org', cooldown: 2, plain: true, block: false },
      { line: 4, url: 'https://gems.example.com', cooldown: 0, plain: false, block: true },
      { line: 6, url: 'https://rubygems.org', cooldown: 'other', plain: false, block: false },
      { line: 7, plain: false, block: false },
      { line: 8, url: 'https://rubygems.org', plain: false, block: false },
    ]);
  });

  it('skips =begin comments and heredocs', () => {
    const text = ['=begin', 'source "https://rubygems.org"', '=end', 'X = <<~TEXT', '  source "https://rubygems.org"', '  TEXT', 'source "https://rubygems.org"'].join('\n');
    expect(gemfileSources(text).map((source) => source.line)).toEqual([7]);
  });

  it('sets the cooldown of the plain calls and keeps everything else, also CRLF and the comment', () => {
    const text = 'source "https://rubygems.org" # public\r\nsource(\'https://rubygems.org\', cooldown: 14)\r\ngem "rack"\r\n';
    expect(setSourceCooldown(text, [1, 2], 3)).toBe('source "https://rubygems.org", cooldown: 3 # public\r\nsource(\'https://rubygems.org\', cooldown: 3)\r\ngem "rack"\r\n');
    expect(setSourceCooldown(setSourceCooldown(text, [1, 2], 3), [1, 2], 3)).toBe(setSourceCooldown(text, [1, 2], 3));
  });

  it('compares gem servers by URL without the trailing slash and case', () => {
    expect(sameServer('HTTPS://RubyGems.org/', 'https://rubygems.org')).toBe(true);
    expect(sameServer('http://rubygems.org', 'https://rubygems.org')).toBe(true);
    expect(sameServer('https://rubygems.org.example.com', 'https://rubygems.org')).toBe(false);
  });

  it('takes gems.rb before the Gemfile, as Bundler does', () => {
    expect(gemfileIn((file) => file === 'Gemfile' || file === 'gems.rb')).toBe('gems.rb');
    expect(gemfileIn((file) => file === 'Gemfile')).toBe('Gemfile');
  });

  it('gives doctor the cooldown of the rubygems.org source without a block', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org" do\nend\nsource "https://rubygems.org", cooldown: 5\n' });
    expect(readSetting(new Repository(root), 'Gemfile', 'cooldown')).toEqual({ file: 'Gemfile', value: 5, line: 3 });
  });
});

describe('detection', () => {
  const facts = detectionFacts(knowledgeBase, environment).commands;

  it('reads bundle commands with the cooldown they get, and gem install bundler with its version', () => {
    const script = [
      'bundle install --cooldown 0',
      'BUNDLE_COOLDOWN=2 bundle lock --update',
      'bundler update --cooldown=1',
      'bundle exec rake',
      'gem install bundler -v 4.0.13',
      'gem install bundler:4.0.23',
      'gem install rails -v 8.1.1',
      'bundle install --cooldown "$DAYS"',
    ].join('\n');
    const found = findToolCommands(script, facts, 0, new Map([['BUNDLE_COOLDOWN', '9']])).commands.map(({ offset: _offset, ...command }) => command);
    expect(found).toEqual([
      { kind: 'install', tool: 'bundler', delay: '0', delayOption: true },
      { kind: 'install', tool: 'bundler', delay: '2' },
      { kind: 'install', tool: 'bundler', delay: '1', delayOption: true },
      { kind: 'upgrade', tool: 'bundler', version: '4.0.13' },
      { kind: 'upgrade', tool: 'bundler', version: '4.0.23' },
      { kind: 'install', tool: 'bundler', delayUnknown: true },
    ]);
  });

  it('takes the version from BUNDLED WITH, from setup-ruby only when it names one, and from gem install bundler', () => {
    const root = repository({
      Gemfile: 'source "https://rubygems.org"\n',
      'Gemfile.lock': LOCK('4.0.17'),
      '.github/workflows/ci.yml': [
        'on: [push]',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: ruby/setup-ruby@v1',
        '        with:',
        '          bundler: latest',
        '      - uses: ruby/setup-ruby@v1',
        '        with:',
        "          bundler: '2.6'",
        '      - run: gem install bundler --version 4.0.20',
        '',
      ].join('\n'),
    });
    const bundler = detectProject(root).packageManagers.find((manager) => manager.id === 'bundler');
    expect(bundler?.versions).toEqual([
      { version: '4.0.17', source: 'lockfile', file: 'Gemfile.lock', line: 13 },
      { version: '2.6', source: 'github-actions', file: '.github/workflows/ci.yml', line: 11, job: 'a', step: 9 },
      { version: '4.0.20', source: 'github-actions', file: '.github/workflows/ci.yml', line: 12, job: 'a' },
    ]);
    expect(bundler?.evidence.map((entry) => entry.kind)).toEqual(['lockfile', 'config', 'ci']);
  });

  it('shows Bundler in explain, with the cooldown in whole days', async () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org"\n', 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('36h') });
    const text = await exec('explain', root);
    expect(text.code).toBe(EXIT_OK);
    expect(text.stdout).toContain('  Bundler\n    versions: 4.0.23 (Gemfile.lock:13, lockfile)\n');
    expect(text.stdout).toContain('    Bundler: 2 days (rounded up)\n');
    const json = JSON.parse((await exec('explain', '--json', root)).stdout) as { policy: { cooldown: { tools: unknown[] } } };
    expect(json.policy.cooldown.tools).toEqual([{ tool: 'bundler', ok: true, unit: 'days', value: 2, exact: false }]);
  });
});

describe('apply', () => {
  it('edits gems.rb, which Bundler reads in place of the Gemfile', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org"\n', 'gems.rb': 'source "https://rubygems.org"\n', 'gems.locked': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d') });
    const report = applyProject(root, { write: true });
    expect(report.changes.map((change) => change.file)).toEqual(['gems.rb']);
    expect(readFileSync(join(root, 'gems.rb'), 'utf8')).toBe('source "https://rubygems.org", cooldown: 3\n');
    expect(readFileSync(join(root, 'Gemfile'), 'utf8')).toBe('source "https://rubygems.org"\n');
  });

  it('writes nothing without a Gemfile and says so', () => {
    const root = repository({ 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d') });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails).toContainEqual({
      code: 'manifest-missing',
      tool: 'bundler',
      location: { file: 'Gemfile' },
      message: 'Bundler: there is no Gemfile, so cooldown is not written; depcurfew does not create project manifests',
      fix: 'If Bundler installs gems for this project, create Gemfile first, then run depcurfew apply again',
    });
  });

  it('does not edit a call over several lines, and says which line to change', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org",\n  cooldown: 1\n', 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d') });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.find((warning) => warning.code === 'cooldown-not-written')).toMatchObject({ tool: 'bundler', location: { file: 'Gemfile', line: 1 } });
  });

  it('says where to add the cooldown when the Gemfile names no rubygems.org source', () => {
    const root = repository({ Gemfile: 'source "https://gems.example.com"\n', 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d') });
    const warning = applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === 'cooldown-not-written');
    expect(warning?.message).toBe('Bundler: cooldown not written: Gemfile has no source "https://rubygems.org" call, and depcurfew configures the cooldown of Bundler only on that source');
  });

  it('names the version a Bundler older than the cooldown needs, 4.0.14 with a lockfile', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org"\n', 'Gemfile.lock': LOCK('2.5.6'), 'depcurfew.json': POLICY('3d') });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.find((warning) => warning.code === 'version-too-old')).toEqual({
      code: 'version-too-old',
      tool: 'bundler',
      message: 'Bundler 2.5.6 does not support cooldown (added in 4.0.13), cooldown once Gemfile.lock exists (added in 4.0.14); not written',
      fix: 'Require Bundler 4.0.14 or later where the version is pinned (BUNDLED WITH of the lockfile changes with bundle update --bundler), then run depcurfew apply again',
    });
  });

  it('writes the cooldown for Bundler 4.0.13 when there is no lockfile yet', () => {
    const root = repository({
      Gemfile: 'source "https://rubygems.org"\n',
      '.github/workflows/ci.yml': 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ruby/setup-ruby@v1\n        with:\n          bundler: 4.0.13\n',
      'depcurfew.json': POLICY('3d'),
    });
    expect(applyProject(root, { write: false }).changes.map((change) => change.after)).toEqual(['source "https://rubygems.org", cooldown: 3\n']);
  });

  it('gives Dependabot bundler entries the cooldown of Bundler and keeps their own exclude', () => {
    const root = repository({
      Gemfile: 'source "https://rubygems.org"\n',
      'Gemfile.lock': LOCK('4.0.23'),
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: bundler\n    directory: /\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 1\n      exclude: ["rack"]\n',
      'depcurfew.json': POLICY('36h', { cooldown: { minimum: '36h', exclude: ['left-pad'] } }),
    });
    applyProject(root, { write: true });
    expect(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')).toContain('      default-days: 2\n      exclude: ["rack"]\n');
  });

  it('leaves gems out of the Renovate rule for npm names', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org"\n', 'Gemfile.lock': LOCK('4.0.23'), 'renovate.json': '{}\n', 'depcurfew.json': POLICY('3d', { cooldown: { minimum: '3d', exclude: ['rake'] } }) });
    applyProject(root, { write: true });
    const config = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')) as { packageRules: { matchDatasources?: string[]; matchPackageNames: string[] }[] };
    expect(config.packageRules).toEqual([expect.objectContaining({ matchDatasources: ['!rubygems'], matchPackageNames: ['rake'] })]);
  });
});

describe('doctor', () => {
  it('reports a Gemfile without the cooldown and stops once apply has run', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org"\ngem "rack"\n', 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d') });
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift').map((finding) => finding.location)).toEqual([{ file: 'Gemfile', line: 1 }]);
    applyProject(root, { write: true });
    expect(runDoctor(root).findings).toEqual([]);
  });

  it('does not count Gemfile.lock as a lockfile it checks', () => {
    const root = repository({ Gemfile: 'source "https://rubygems.org", cooldown: 3\n', 'Gemfile.lock': LOCK('4.0.23'), 'depcurfew.json': POLICY('3d', { sources: { git: 'deny' } }) });
    const results = Object.fromEntries((runDoctor(root).checked?.rules ?? []).map((entry) => [entry.rule, entry.result]));
    expect(results).toMatchObject({ 'lockfile-forbidden-source': 'not-applicable', 'lockfile-install-scripts': 'not-applicable', 'known-malicious': 'not-applicable', 'bundler-config-weakens': 'passed' });
  });

  it('reads BUNDLE_COOLDOWN as Bundler does: false leaves the Gemfile in charge, any other text without digits is 0', () => {
    const findings = (value: string) =>
      runDoctor(repository({ Gemfile: 'source "https://rubygems.org", cooldown: 3\n', 'Gemfile.lock': LOCK('4.0.23'), '.bundle/config': `---\nBUNDLE_COOLDOWN: "${value}"\n`, 'depcurfew.json': POLICY('3d') })).findings.filter(
        (finding) => finding.rule === 'bundler-config-weakens',
      );
    expect(findings('false')).toEqual([]);
    expect(findings('7 days')).toEqual([]);
    expect(findings('')).toHaveLength(1);
    expect(findings('seven')[0]?.message).toContain('turns off the cooldown of Bundler for every source');
  });

  it('is valid with targets that name bundler', () => {
    expect(parsePolicy(JSON.stringify({ version: 1, targets: ['bundler'] })).ok).toBe(true);
  });
});
