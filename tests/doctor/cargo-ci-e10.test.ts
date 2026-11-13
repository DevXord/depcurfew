// ci-weakens-policy for Cargo (E10, first part): CI workflows and Dockerfiles that undo, for the cargo commands they
// run, the release-age delay depcurfew apply writes into .cargo/config.toml. Cargo takes CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE,
// CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE and CARGO_REGISTRIES_<name>_MIN_PUBLISH_AGE (both spellings, fail closed) over
// its files, and --config (KEY=VALUE in TOML, or a path to a file) over the variables. A delay of zero or a shorter one
// and "allow" are errors; a span Cargo may wrap, a value with $, a file depcurfew cannot read, an include and a --config
// argument too long or too deep to read are warnings.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPolicyIfPresent } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { cpuNow } from '../support/cpu-time.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'allow' }, sources: { git: 'allow', remoteTarball: 'allow', file: 'allow', directory: 'allow' }, targets: ['cargo'] };
const BASE = {
  'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
  'Cargo.lock': 'version = 4\n',
  '.cargo/config.toml': '[registry]\n# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nglobal-min-publish-age = "3 days"\n# <<< depcurfew managed block\n',
};

function repository(files: Record<string, string>, policy: object = POLICY): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e10-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries({ ...BASE, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify(policy));
  return root;
}

function found(root: string) {
  return runDoctor(root, { policy: loadPolicyIfPresent(root) ?? null })
    .findings.filter((finding) => finding.rule === 'ci-weakens-policy')
    .map((finding) => ({ level: finding.level, file: finding.location?.file, line: finding.location?.line, message: finding.message, fix: finding.fix }));
}

const workflow = (lines: string) => ({ '.github/workflows/ci.yml': `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${lines}` });
const step = (run: string, env?: Record<string, string>) =>
  `      - run: ${run}\n${env === undefined ? '' : `        env:\n${Object.entries(env).map(([name, value]) => `          ${name}: ${JSON.stringify(value)}\n`).join('')}`}`;
const levels = (root: string) => found(root).map((finding) => finding.level);

describe('Cargo variables in CI workflows and Dockerfiles (E10)', () => {
  it('reports a delay of zero and a shorter delay as errors, and leaves a longer one', () => {
    const off = found(repository(workflow(step('cargo build --locked', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '0' }))));
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ level: 'error', file: '.github/workflows/ci.yml', line: 8 });
    expect(off[0]?.message).toContain('CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE=0');
    expect(off[0]?.message).toContain('turns off the release-age delay of Cargo (3d in depcurfew.json)');
    expect(off[0]?.fix).toContain('cooldown.exclude');
    const shorter = found(repository(workflow(step('cargo build', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '1 day' }))));
    expect(shorter.map((finding) => [finding.level, finding.message.includes('sets the release-age delay of Cargo to 1 day, shorter than the 3d of depcurfew.json')])).toEqual([['error', true]]);
    expect(found(repository(workflow(step('cargo build', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '7 days' }))))).toEqual([]);
  });

  it('warns about a span Cargo may wrap to a short delay, with the reason', () => {
    const wrapped = found(repository(workflow(step('cargo build', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '7014648591047 months' }))));
    expect(wrapped.map((finding) => finding.level)).toEqual(['warning']);
    expect(wrapped[0]?.message).toContain('"7014648591047 months" is more seconds than Cargo counts, and Cargo may wrap it to a short delay');
  });

  it('reports CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow, exported in a run step, and not deny', () => {
    const allow = found(repository(workflow(step('export CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow && cargo update'))));
    expect(allow.map((finding) => finding.level)).toEqual(['error']);
    expect(allow[0]?.message).toContain('CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow');
    expect(allow[0]?.message).toContain('weakens the release-age delay of Cargo');
    expect(found(repository(workflow(step('export CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=deny && cargo update'))))).toEqual([]);
  });

  it('reports the variable of crates.io in both spellings', () => {
    expect(levels(repository(workflow(step('cargo update', { 'CARGO_REGISTRIES_crates-io_MIN_PUBLISH_AGE': '0', CARGO_REGISTRIES_CRATES_IO_MIN_PUBLISH_AGE: '1 hour' }))))).toEqual(['error', 'error']);
  });

  it('reports ENV of a Dockerfile, and warns about a value with $', () => {
    const docker = found(repository({ Dockerfile: 'FROM rust:1.100\nENV CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE=0\nRUN cargo build --release\n' }));
    expect(docker.map((finding) => [finding.level, finding.file, finding.line])).toEqual([['error', 'Dockerfile', 2]]);
    expect(levels(repository(workflow(step('cargo build', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '${{ vars.AGE }}' }))))).toEqual(['warning']);
  });

  it('reports nothing when the policy has no delay or does not target Cargo', () => {
    const files = workflow(step('cargo build', { CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '0' }));
    const { cooldown: _cooldown, ...withoutDelay } = POLICY;
    expect(found(repository(files, withoutDelay))).toEqual([]);
    expect(found(repository({ ...files, 'package.json': '{"name":"web"}' }, { ...POLICY, targets: ['npm'] }))).toEqual([]);
  });
});

describe('cargo --config in CI workflows and Dockerfiles (E10)', () => {
  it('reads KEY=VALUE in TOML, before or after the command, with spaces and after +toolchain', () => {
    const root = repository(
      workflow(
        [
          step(`cargo --config 'registry.global-min-publish-age="0"' build`),
          step(`cargo update --config 'resolver.incompatible-publish-age="allow"'`),
          step(`cargo +nightly --config "registries.crates-io.min-publish-age = '1 hour'" update`),
          step(`cargo --config=registry.global-min-publish-age='"1 day"' build`),
          step(`cargo --config 'net.git-fetch-with-cli=true' --config 'registry.global-min-publish-age="2 weeks"' fetch`),
        ].join(''),
      ),
    );
    const reported = found(root);
    expect(reported.map((finding) => [finding.level, finding.line])).toEqual([
      ['error', 6],
      ['error', 7],
      ['error', 8],
      ['error', 9],
    ]);
    expect(reported[0]?.message).toContain(`runs Cargo with --config registry.global-min-publish-age="0", which turns off the release-age delay of Cargo (3d in depcurfew.json)`);
    expect(reported[1]?.message).toContain('which weakens the release-age delay of Cargo');
    expect(reported[2]?.message).toContain('sets the release-age delay of Cargo to 1 hour, shorter than the 3d of depcurfew.json');
    expect(reported[0]?.fix).toContain(`Remove --config registry.global-min-publish-age="0" from that command in .github/workflows/ci.yml`);
  });

  it('reads a file given to --config, and warns about one depcurfew cannot read', () => {
    const root = repository({ 'ci/cargo.toml': '[resolver]\nincompatible-publish-age = "allow"\n', ...workflow(step('cargo --config ci/cargo.toml build') + step('cargo --config ci/missing.toml build')) });
    const reported = found(root);
    expect(reported.map((finding) => [finding.level, finding.line])).toEqual([
      ['error', 6],
      ['warning', 7],
    ]);
    expect(reported[0]?.message).toContain('resolver.incompatible-publish-age = "allow" in ci/cargo.toml');
    expect(reported[1]?.message).toContain('ci/missing.toml, a file depcurfew cannot read');
  });

  it('warns about an include in --config, and about an argument too long or too deep to read', () => {
    expect(found(repository(workflow(step(`cargo --config 'include = ["more.toml"]' build`)))).map((finding) => [finding.level, finding.message.includes('include')])).toEqual([['warning', true]]);
    const deep = `cargo --config 'build.x=${'['.repeat(100)}${']'.repeat(100)}' build`;
    expect(levels(repository(workflow(step(deep))))).toEqual(['warning']);
    const long = `cargo --config 'build.x="${'a'.repeat(20_000)}"' build`;
    expect(levels(repository(workflow(step(long))))).toEqual(['warning']);
  });

  it('reads a long or deep --config argument in linear time', () => {
    const start = cpuNow();
    const root = repository(workflow(step(`cargo --config 'build.x=${'['.repeat(5000)}' build`) + step(`cargo --config '${'a.'.repeat(5000)}b=1' build`)));
    found(root);
    expect(cpuNow() - start).toBeLessThan(2000);
  });
});

// The second part of E10: Cargo configuration files depcurfew apply does not write. Cargo reads the configuration of the
// directory it runs in before that of its parents, so a .cargo/config.toml (or .cargo/config, which Cargo uses when both
// are there) of a workspace member undoes the delay of the root for cargo commands run there. A file the root
// configuration includes cannot change a key the root sets itself, but can add the others. [env] does not change the
// Cargo that reads it, only a cargo started by a build script or by cargo run, so a CARGO_ variable there is a warning.
const WORKSPACE = {
  'Cargo.toml': '[workspace]\nmembers = ["app", "tool"]\n',
  'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
  'tool/Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"\n',
};

describe('Cargo configuration files depcurfew apply does not write (E10)', () => {
  it('reports a member configuration that turns the delay off or shortens it, where it does', () => {
    const root = repository({ ...WORKSPACE, 'tool/.cargo/config.toml': '[build]\njobs = 2\n\n[registry]\nglobal-min-publish-age = "0"\n\n[resolver]\nincompatible-publish-age = "allow"\n' });
    const reported = found(root);
    expect(reported.map((finding) => [finding.level, finding.file, finding.line])).toEqual([
      ['error', 'tool/.cargo/config.toml', 5],
      ['error', 'tool/.cargo/config.toml', 8],
    ]);
    expect(reported[0]?.message).toBe(
      'tool/.cargo/config.toml (line 5) sets registry.global-min-publish-age = "0", which turns off the release-age delay of Cargo (3d in depcurfew.json) for cargo commands run in tool: Cargo reads the configuration of the directory it runs in before that of its parents',
    );
    expect(reported[0]?.fix).toBe('Remove registry.global-min-publish-age from tool/.cargo/config.toml: Cargo also reads the delay depcurfew apply writes into .cargo/config.toml at the root when it runs in tool; for a package that cannot wait, add it to cooldown.exclude in depcurfew.json and run depcurfew apply');
    expect(reported[1]?.message).toContain('sets resolver.incompatible-publish-age = "allow", which weakens the release-age delay of Cargo');
  });

  it('reads the .cargo/config of a member when both names are there, as Cargo does, and leaves a longer delay', () => {
    const both = repository({ ...WORKSPACE, 'app/.cargo/config': '[registry]\nglobal-min-publish-age = "1 hour"\n', 'app/.cargo/config.toml': '[registry]\nglobal-min-publish-age = "0"\n' });
    expect(found(both).map((finding) => [finding.level, finding.file, finding.line])).toEqual([['error', 'app/.cargo/config', 2]]);
    expect(found(repository({ ...WORKSPACE, 'app/.cargo/config.toml': '[registry]\nglobal-min-publish-age = "2 weeks"\n' }))).toEqual([]);
  });

  it('follows include: of a member fully, of the root only for keys the root does not set itself', () => {
    const root = repository({
      ...WORKSPACE,
      '.cargo/config.toml': `include = ["shared.toml"]\n\n${BASE['.cargo/config.toml']}`,
      '.cargo/shared.toml': '[registry]\nglobal-min-publish-age = "0"\n\n[registries.crates-io]\nmin-publish-age = "1 day"\n',
      'tool/.cargo/config.toml': 'include = [{ path = "ci.toml", optional = true }, "../../../outside.toml"]\n',
      'tool/.cargo/ci.toml': '[resolver]\nincompatible-publish-age = "allow"\n',
    });
    const reported = found(root);
    expect(reported.map((finding) => [finding.level, finding.file, finding.line])).toEqual([
      ['error', '.cargo/shared.toml', 5],
      ['error', 'tool/.cargo/ci.toml', 2],
      ['warning', 'tool/.cargo/config.toml', 1],
    ]);
    expect(reported[0]?.message).toContain('included by .cargo/config.toml');
    expect(reported[2]?.message).toContain('../../../outside.toml, which depcurfew cannot read');
  });

  it('warns about a CARGO_ variable of the delay in [env], which reaches only a cargo that build scripts or cargo run start', () => {
    const root = repository({ '.cargo/config.toml': `${BASE['.cargo/config.toml']}\n[env]\nCARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE = "0"\nCARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE = { value = "allow", force = true }\nOPENSSL_DIR = "/opt/openssl"\n` });
    const reported = found(root);
    expect(reported.map((finding) => [finding.level, finding.file, finding.line])).toEqual([
      ['warning', '.cargo/config.toml', 7],
      ['warning', '.cargo/config.toml', 8],
    ]);
    expect(reported[0]?.message).toBe(
      '.cargo/config.toml (line 7) sets CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE = "0" in [env], which does not change the Cargo that reads the file but reaches build scripts and the programs cargo run starts, so a cargo they run in turn (an xtask, for example) takes it, and it turns off the release-age delay of Cargo (3d in depcurfew.json)',
    );
  });

  it('checks the files without a CI workflow, and not without a delay in the policy', () => {
    const files = { ...WORKSPACE, 'tool/.cargo/config.toml': '[registry]\nglobal-min-publish-age = "0"\n' };
    expect(levels(repository(files))).toEqual(['error']);
    const { cooldown: _cooldown, ...withoutDelay } = POLICY;
    expect(found(repository(files, withoutDelay))).toEqual([]);
  });
});
