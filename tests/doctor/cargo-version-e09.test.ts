// manager-version-too-old for Cargo (E09, D-197 point 6). The Rust a directory pins in rust-toolchain.toml or
// rust-toolchain chooses its Cargo, and Cargo applies registry.global-min-publish-age from Rust 1.100.0 on. An exact
// release below it is an error, a channel X.Y (the latest X.Y release, extra.toolchainChannels) a warning, and a
// toolchain without a Rust release (beta, nightly, a dated channel) or a pre-release of 1.100.0 itself a note: depcurfew
// cannot tell, so never an error. A custom toolchain stays a notice with its reason. The description of the rule fits
// the SARIF limit without a cut, and the versions in it come from the knowledge base.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { run } from '../../src/cli/run.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { managerVersionTooOld } from '../../src/doctor/rules/manager-version.ts';
import { bundler } from '../../src/knowledge/bundler.ts';
import { cargo } from '../../src/knowledge/cargo.ts';
import { composer } from '../../src/knowledge/composer.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { yarn } from '../../src/knowledge/yarn.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n';
const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'allow' }, sources: { git: 'allow', remoteTarball: 'allow', file: 'allow', directory: 'allow' }, targets: ['cargo'] };
const NEEDS = 'registry.global-min-publish-age (added in 1.100.0)';
const SET = 'Set channel in [toolchain] of rust-toolchain.toml to "1.100.0" or a later Rust release';

function repository(files: Record<string, string>, policy: object | null = POLICY): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e09-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries({ 'Cargo.toml': CARGO, ...files })) writeFileSync(join(root, file), text);
  if (policy !== null) writeFileSync(join(root, 'depcurfew.json'), JSON.stringify(policy));
  return root;
}

const toolchain = (channel: string) => repository({ 'rust-toolchain.toml': `[toolchain]\nchannel = "${channel}"\n` });

function findings(root: string) {
  const report = runDoctor(root);
  return {
    found: report.findings
      .filter((finding) => finding.rule === 'manager-version-too-old')
      .map((finding) => ({ level: finding.level, file: finding.location?.file, line: finding.location?.line, message: finding.message, fix: finding.fix })),
    notices: report.notices.map((notice) => notice.message).filter((message) => message.startsWith('manager-version-too-old')),
  };
}

describe('manager-version-too-old for Cargo (E09)', () => {
  it('reports an exact Rust release below 1.100.0 as an error, with the fix in channel', () => {
    expect(findings(toolchain('1.85.0')).found).toEqual([
      { level: 'error', file: 'rust-toolchain.toml', line: 2, message: `rust-toolchain.toml pins Rust 1.85.0, whose Cargo does not support ${NEEDS}`, fix: SET },
    ]);
  });

  it('names the channel when it has a host after the release', () => {
    expect(findings(toolchain('1.85.0-x86_64-unknown-linux-gnu')).found).toEqual([
      { level: 'error', file: 'rust-toolchain.toml', line: 2, message: `rust-toolchain.toml pins Rust 1.85.0 (channel "1.85.0-x86_64-unknown-linux-gnu"), whose Cargo does not support ${NEEDS}`, fix: SET },
    ]);
  });

  it('reports a channel X.Y below 1.100 as a warning: rustup runs the latest X.Y release', () => {
    expect(findings(toolchain('1.99')).found).toEqual([
      { level: 'warning', file: 'rust-toolchain.toml', line: 2, message: `rust-toolchain.toml pins the channel "1.99", the latest Rust 1.99 release, whose Cargo does not support ${NEEDS}`, fix: SET },
    ]);
  });

  it('never reports a pre-release of 1.100.0 as an error, only a note; an earlier pre-release is older than its release', () => {
    expect(findings(toolchain('1.100.0-beta.5')).found).toEqual([
      {
        level: 'note',
        file: 'rust-toolchain.toml',
        line: 2,
        message: `rust-toolchain.toml pins Rust 1.100.0-beta.5, a pre-release of Rust 1.100.0, and depcurfew cannot tell whether its Cargo supports ${NEEDS}`,
        fix: SET,
      },
    ]);
    expect(findings(toolchain('1.99.0-beta.2')).found.map((finding) => [finding.level, finding.message])).toEqual([['error', `rust-toolchain.toml pins Rust 1.99.0-beta.2, whose Cargo does not support ${NEEDS}`]]);
  });

  it.each(['beta', 'nightly', 'nightly-2026-11-01', 'beta-2026-10-20', 'stable-2026-10-01'])('gives a note for the channel %s, which names no Rust release', (channel) => {
    const { found, notices } = findings(toolchain(channel));
    expect(notices).toEqual([]);
    expect(found).toEqual([
      {
        level: 'note',
        file: 'rust-toolchain.toml',
        line: 2,
        message: `rust-toolchain.toml uses the rustup channel ${channel}, which names no Rust release, so depcurfew cannot tell whether its Cargo supports ${NEEDS}`,
        fix: 'Pin a Rust release of 1.100.0 or later in channel in [toolchain] of rust-toolchain.toml, or make sure the Cargo of this toolchain is from Rust 1.100.0 or later',
      },
    ]);
  });

  it.each(['1.100.0', '1.100', '1.101.0-beta.1', 'stable'])('reports nothing for %s', (channel) => {
    expect(findings(toolchain(channel))).toEqual({ found: [], notices: [] });
  });

  it('keeps a notice with the reason for a custom toolchain and for a rust-toolchain.toml that is not TOML', () => {
    expect(findings(toolchain('my-toolchain'))).toEqual({
      found: [],
      notices: ['manager-version-too-old cannot evaluate Cargo version "my-toolchain" in rust-toolchain.toml: my-toolchain is a custom rustup toolchain, whose Rust version depcurfew cannot tell'],
    });
    const bare = repository({ 'rust-toolchain.toml': '1.85.0\n' });
    expect(findings(bare)).toEqual({
      found: [],
      notices: ['manager-version-too-old cannot evaluate Cargo version "1.85.0" in rust-toolchain.toml: rustup reads rust-toolchain.toml as TOML only, and this one is not TOML with [toolchain] channel'],
    });
  });

  it('gives the fix for the legacy rust-toolchain in its own format', () => {
    const legacy = repository({ 'rust-toolchain': '1.85.0\n' });
    expect(findings(legacy).found).toEqual([
      { level: 'error', file: 'rust-toolchain', line: 1, message: `rust-toolchain pins Rust 1.85.0, whose Cargo does not support ${NEEDS}`, fix: 'Replace 1.85.0 in rust-toolchain with 1.100.0 or a later Rust release' },
    ]);
    const toml = repository({ 'rust-toolchain': '[toolchain]\nchannel = "1.85.0"\n' });
    expect(findings(toml).found.map((finding) => finding.fix)).toEqual(['Set channel in [toolchain] of rust-toolchain to "1.100.0" or a later Rust release']);
  });

  it('compares with the default policy as a note when the repository has no depcurfew.json', async () => {
    const root = repository({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.85.0"\n' }, null);
    let stdout = '';
    expect(await run(['doctor', '--json', root], { stdout: (text) => (stdout += text), stderr: () => {} })).toBe(0);
    const report = JSON.parse(stdout) as { findings: { rule: string; level: string; message: string }[] };
    const found = report.findings.filter((finding) => finding.rule === 'manager-version-too-old');
    expect(found.map((finding) => [finding.level, finding.message.startsWith('rust-toolchain.toml pins Rust 1.85.0, whose Cargo does not support')])).toEqual([['note', true]]);
  });
});

describe('the description of manager-version-too-old (E09)', () => {
  const lastNpm = (line: string) => values(environment.node.bundledNpm)[0]?.find((entry) => entry.line === line)?.bundles.at(-1)?.[1] ?? '';
  const short = (version: string) => version.replace(/\.0$/u, '');

  it('fits the SARIF limit of 1024 characters without a cut', () => {
    expect(managerVersionTooOld.description.length).toBeLessThanOrEqual(1024);
  });

  it('takes its versions from the knowledge base and names Cargo with the levels of D-197', () => {
    const description = managerVersionTooOld.description;
    const npmMajor = lastNpm('22').split('.')[0] ?? '';
    expect(npmMajor).toBe('10');
    expect(description).toContain(`Node.js 22 comes with npm ${npmMajor}`);
    expect(description).toContain(`older than ${short((values(composer.extra?.['pluginApiVersion'] as never)[0] as { cooldownApi: string }).cooldownApi)}`);
    expect(description).toContain(`needs ${(values(bundler.extra?.['cooldownWithLockfile'] as never)[0] as { since: string }).since}`);
    expect(description).toContain(`every Yarn from ${short((values(yarn.extra?.['yarnPathRuns'] as never)[0] as { classicSince: string }).classicSince)}`);
    expect(description).toContain(`below ${values(cargo.cooldown.availableSince)[0]} is an error`);
    expect(description).toContain('rust-toolchain');
  });
});
