// apply writes Cargo's own release-age delay (E07): one [registry] block with global-min-publish-age in
// .cargo/config.toml. A value written by hand is replaced (a longer one with cooldown-shortened), one depcurfew cannot
// read, or a product of seconds Cargo may wrap, is left with cooldown-not-written. A setting in the same file that undoes
// the delay (resolver.incompatible-publish-age = "allow", a shorter [registries.crates-io] min-publish-age) is reported
// with cooldown-overridden, and the limits of Cargo's delay with cooldown-limits. The older name .cargo/config gets
// "rename it", and apply never writes a config.toml next to it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { blockStart, BLOCK_END } from '../../src/apply/block.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { run } from '../../src/cli/run.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CARGO = { 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n', 'Cargo.lock': 'version = 4\n' };
const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'allow' }, sources: { git: 'allow', remoteTarball: 'allow', file: 'allow', directory: 'allow' }, targets: ['cargo'] };
const BLOCK = [blockStart(), 'global-min-publish-age = "3 days"', BLOCK_END];

function repository(files: Record<string, string>, policy: object = POLICY): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e07-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries({ ...CARGO, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify(policy));
  return root;
}

const read = (root: string, file = '.cargo/config.toml') => readFileSync(join(root, file), 'utf8');
const lines = (...parts: (string | readonly string[])[]) => `${parts.flat().join('\n')}\n`;
type Warning = { code: string; location?: { file: string; line?: number }; message: string; fix?: string };
const codes = (report: { warningDetails: Warning[] }) => report.warningDetails.map((warning) => warning.code).filter((code) => code !== 'version-not-pinned');
const warning = (report: { warningDetails: Warning[] }, code: string) => report.warningDetails.find((entry) => entry.code === code);

describe('apply writes the delay of Cargo (E07)', () => {
  it('writes a [registry] block in .cargo/config.toml, and changes nothing the second time', () => {
    const root = repository({});
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift').map((finding) => finding.message).join('\n')).toContain('.cargo/config.toml');
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(read(root)).toBe(lines('[registry]', BLOCK));
    expect(codes(report)).toEqual(['cooldown-limits']);
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it('adds the block to the [registry] table of the file, keeping its other keys', () => {
    const root = repository({ '.cargo/config.toml': lines('[registry]', 'default = "crates-io"', '', '[build]', 'jobs = 4') });
    applyProject(root);
    expect(read(root)).toBe(lines('[registry]', 'default = "crates-io"', '', BLOCK, '', '[build]', 'jobs = 4'));
  });

  it('replaces a value written by hand, and says so when it was longer', () => {
    const longer = repository({ '.cargo/config.toml': lines('[registry]', 'global-min-publish-age = "7 days"') });
    const report = applyProject(longer);
    expect(read(longer)).toContain('# depcurfew: superseded by the managed block: global-min-publish-age = "7 days"');
    expect(warning(report, 'cooldown-shortened')?.location).toEqual({ file: '.cargo/config.toml', line: 2 });
    const shorter = repository({ '.cargo/config.toml': lines('[registry]', 'global-min-publish-age = "1 day"') });
    expect(codes(applyProject(shorter))).toEqual(['cooldown-limits']);
  });

  it.each([
    ['7 dayz', '"7 dayz" is not a time span Cargo reads'],
    ['99999999999999 months', '"99999999999999 months" is more seconds than Cargo counts, and Cargo may wrap it to a short delay'],
  ])('leaves %j as it is, with cooldown-not-written', (value, reason) => {
    const root = repository({ '.cargo/config.toml': lines('[registry]', `global-min-publish-age = "${value}"`) });
    const report = applyProject(root);
    expect(read(root)).toBe(lines('[registry]', `global-min-publish-age = "${value}"`));
    expect(warning(report, 'cooldown-not-written')).toMatchObject({ location: { file: '.cargo/config.toml', line: 2 } });
    expect(warning(report, 'cooldown-not-written')?.message).toContain(reason);
  });

  it('reports a setting of the file that undoes the delay, and leaves it', () => {
    const root = repository({ '.cargo/config.toml': lines('[resolver]', 'incompatible-publish-age = "allow"', '', '[registries.crates-io]', 'min-publish-age = "1 day"') });
    const report = applyProject(root);
    const overridden = report.warningDetails.filter((entry) => entry.code === 'cooldown-overridden');
    expect(overridden.map((entry) => entry.location)).toEqual([
      { file: '.cargo/config.toml', line: 2 },
      { file: '.cargo/config.toml', line: 5 },
    ]);
    expect(overridden[0]?.message).toBe('Cargo: resolver.incompatible-publish-age = "allow" in .cargo/config.toml (line 2) turns the release-age delay off, the one depcurfew apply writes included');
    expect(overridden[0]?.fix).toBe('Remove resolver.incompatible-publish-age from .cargo/config.toml, or set it to "deny"; for one version that has to come sooner, use cargo update --precise with it for that command only');
    expect(overridden[1]?.message).toBe('Cargo: registries.crates-io.min-publish-age in .cargo/config.toml (line 5) is "1 day", which takes the place of the 3 days depcurfew apply writes for crates.io');
    expect(read(root)).toContain('incompatible-publish-age = "allow"');
    expect(read(root)).toContain('min-publish-age = "1 day"');
  });

  it('does not report a crates-io value at least as long as the policy', () => {
    const root = repository({ '.cargo/config.toml': lines('[registries.crates-io]', 'min-publish-age = "5 days"') });
    expect(codes(applyProject(root))).toEqual(['cooldown-limits']);
  });

  it('names the limits of the delay of Cargo', () => {
    const report = applyProject(repository({}));
    expect(warning(report, 'cooldown-limits')).toMatchObject({
      code: 'cooldown-limits',
      location: { file: '.cargo/config.toml' },
      message: 'Cargo: global-min-publish-age holds back new versions when Cargo resolves dependencies, but not cargo install of a crate, not versions a registry gives no publish time, and not versions already in Cargo.lock; a value in $CARGO_HOME/config.toml, an environment variable or --config takes the place of the one in .cargo/config.toml',
      fix: 'Install tools with cargo install --locked and an exact --version; check CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE, CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE and $CARGO_HOME/config.toml where Cargo runs',
    });
  });

  it('warns about what Cargo cannot enforce: build scripts, git and path sources, exceptions', () => {
    const policy = { version: 1, cooldown: { minimum: '3d', exclude: ['left-pad'] }, installScripts: { default: 'deny' }, sources: { git: 'deny', remoteTarball: 'deny', file: 'deny', directory: 'deny' }, targets: ['cargo'] };
    const report = applyProject(repository({}, policy));
    expect(codes(report).sort()).toEqual(['cooldown-limits', 'exclude-unsupported', 'scripts-not-enforceable', 'source-not-enforceable', 'source-not-enforceable']);
  });

  it('writes the key for a toolchain older than 1.100.0 too', () => {
    const root = repository({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.85.0"\n' });
    const report = applyProject(root);
    expect(read(root)).toBe(lines('[registry]', BLOCK));
    expect(codes(report)).toContain('version-too-old');
  });
});

describe('the older name .cargo/config (E07)', () => {
  it('is not written, and the fix says to rename it; no config.toml is created next to it', () => {
    const root = repository({ '.cargo/config': lines('[build]', 'jobs = 4') });
    const report = applyProject(root);
    expect(existsSync(join(root, '.cargo/config.toml'))).toBe(false);
    expect(warning(report, 'cooldown-not-written')).toMatchObject({
      code: 'cooldown-not-written',
      location: { file: '.cargo/config' },
      message: 'Cargo: cooldown not written: the Cargo configuration of this directory is .cargo/config, the older name, which depcurfew apply does not edit',
      fix: 'Rename .cargo/config to .cargo/config.toml, the name Cargo prefers (it reads both), then run depcurfew apply again',
    });
  });

  it('asks to merge the two when both are there', () => {
    const root = repository({ '.cargo/config': lines('[build]', 'jobs = 4'), '.cargo/config.toml': lines('[net]', 'retry = 3') });
    const report = applyProject(root);
    expect(read(root)).toBe(lines('[net]', 'retry = 3'));
    expect(warning(report, 'cooldown-not-written')?.fix).toBe('Move the settings of .cargo/config into .cargo/config.toml and delete .cargo/config (Cargo reads .cargo/config and ignores .cargo/config.toml when both are there), then run depcurfew apply again');
  });
});

describe('doctor reports what apply cannot keep for Cargo (E07)', () => {
  const drift = (root: string) => runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift');

  it('reports each setting that undoes the delay at its line, with the text of apply, before and after apply', () => {
    const root = repository({ '.cargo/config.toml': lines('[resolver]', 'incompatible-publish-age = "allow"', '', '[registries.crates-io]', 'min-publish-age = "0"') });
    const expected = [
      { line: 2, message: 'Cargo: resolver.incompatible-publish-age = "allow" in .cargo/config.toml (line 2) turns the release-age delay off, the one depcurfew apply writes included' },
      { line: 5, message: 'Cargo: registries.crates-io.min-publish-age in .cargo/config.toml (line 5) is "0", which takes the place of the 3 days depcurfew apply writes for crates.io' },
    ];
    const reported = () => drift(root).filter((finding) => finding.message.startsWith('Cargo: ')).map((finding) => ({ line: finding.location?.line, message: finding.message }));
    expect(reported()).toEqual(expected);
    applyProject(root);
    expect(reported()).toEqual(expected);
    expect(drift(root).every((finding) => finding.level === 'error')).toBe(true);
  });

  it('reports a value apply cannot read, and the older name, where they are', () => {
    const unreadable = repository({ '.cargo/config.toml': lines('[registry]', 'global-min-publish-age = "99999999999999 months"') });
    expect(drift(unreadable).map((finding) => [finding.location?.file, finding.location?.line, finding.message.startsWith('Cargo: cooldown not written')])).toEqual([['.cargo/config.toml', 2, true]]);
    const legacy = repository({ '.cargo/config': lines('[build]', 'jobs = 4') });
    expect(drift(legacy).map((finding) => [finding.location?.file, finding.fix])).toEqual([['.cargo/config', 'Rename .cargo/config to .cargo/config.toml, the name Cargo prefers (it reads both), then run depcurfew apply again']]);
  });
});

describe('init keeps a longer delay of Cargo (E07)', () => {
  it('takes registry.global-min-publish-age as cooldown.minimum when it is longer than the default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-e07-init-'));
    temporary.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '.cargo'));
    writeFileSync(join(root, 'Cargo.toml'), CARGO['Cargo.toml']);
    writeFileSync(join(root, '.cargo/config.toml'), lines('[registry]', 'global-min-publish-age = "2 weeks"'));
    let stdout = '';
    const code = await run(['init', '--json', root], { stdout: (text) => (stdout += text), stderr: () => {} });
    expect(code).toBe(0);
    expect((JSON.parse(readFileSync(join(root, 'depcurfew.json'), 'utf8')) as { cooldown: { minimum: string } }).cooldown.minimum).toBe('14d');
    expect(stdout).toContain('cooldown-kept');
  });
});
