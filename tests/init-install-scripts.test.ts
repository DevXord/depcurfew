// depcurfew init and the install scripts of the lockfiles (decision D-127): the packages whose scripts depcurfew knows
// go into installScripts.deny with a note each that says why and what changes, the others are listed to review, and
// a lockfile that records no install scripts gets a note, so nothing that "deny" blocks goes unsaid.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, run } from '../src/cli/run.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { parsePolicy } from '../src/policy/validate.ts';

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

const KNOWN = fileURLToPath(new URL('fixtures/doctor/lockfile-install-scripts/fires-npm12-known-packages/repo', import.meta.url));

const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      esbuild:
        specifier: ^0.28.2
        version: 0.28.2
      lefthook:
        specifier: ^2.2.2
        version: 2.2.2
      core-js:
        specifier: ^3.38.1
        version: 3.38.1

packages:

  core-js@3.38.1:
    resolution: {integrity: sha512-DDDD}

  esbuild@0.28.2:
    resolution: {integrity: sha512-AAAA}
    hasBin: true

  lefthook@2.2.2:
    resolution: {integrity: sha512-CCCC}
    hasBin: true

snapshots:

  core-js@3.38.1: {}

  esbuild@0.28.2: {}

  lefthook@2.2.2: {}
`;

describe('depcurfew init and install scripts', () => {
  let directory: string;
  let policyFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'depcurfew-init-scripts-'));
    policyFile = join(directory, 'depcurfew.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), content);
    }
  };
  const deny = () => (JSON.parse(readFileSync(policyFile, 'utf8')) as { installScripts: { deny: string[] } }).installScripts.deny;

  it('denies esbuild, fsevents and lefthook from package-lock.json, says why for each, and lists the other packages to review', async () => {
    cpSync(KNOWN, directory, { recursive: true });
    rmSync(policyFile);
    const result = await exec('init', directory);
    expect(result).toEqual({
      code: EXIT_OK,
      stdout:
        `Created ${policyFile} with the default policy.\n` +
        'Detected tools: npm.\n' +
        'note: esbuild in package-lock.json has an install script (postinstall: node install.js) that it does not need, so init adds it to installScripts.deny: it only puts the binary, which esbuild takes from an optional dependency for the platform, in place of the esbuild command and checks that it runs; without it the esbuild command starts through a small Node.js script instead of the binary itself (install.js never makes that change on Windows or with Yarn anyway), and the install no longer checks that the binary runs; the package then needs its optional dependencies, which hold its binary (install-script-denied)\n' +
        '  fix: Keep optional dependencies installed (no omit=optional in .npmrc, no --omit=optional or --no-optional on the install), or move esbuild to installScripts.allow in depcurfew.json only if you want its script to run\n' +
        'note: fsevents in package-lock.json has an install script (install: node-gyp rebuild) that it does not need, so init adds it to installScripts.deny: it is the node-gyp rebuild that npm adds because the source has a binding.gyp, while the package already contains the built fsevents.node; without it nothing changes (install-script-denied)\n' +
        '  fix: Leave it in installScripts.deny; move fsevents to installScripts.allow in depcurfew.json only if you want its script to run\n' +
        'note: lefthook in package-lock.json has an install script (postinstall: node postinstall.js) that only does a task of the project, so init adds it to installScripts.deny: it runs lefthook install, which installs the git hooks of the repository; without it the install no longer installs the git hooks (depcurfew checked lefthook 2.2.2; package-lock.json has 2.1.0, so check that it works the same) (install-script-project-task)\n' +
        '  fix: Run lefthook install after each clone of the repository, as the lefthook documentation says for projects that do not use its postinstall script, or move lefthook to installScripts.allow in depcurfew.json only if you want its script to run\n' +
        'note: package-lock.json has packages with install scripts that installScripts.default "deny" blocks and depcurfew does not know: core-js (install-scripts-to-review)\n' +
        '  fix: Review each one before you run depcurfew apply: add it to installScripts.allow in depcurfew.json if it needs its scripts, or to installScripts.deny if it works without them (depcurfew doctor lists them with their lines in package-lock.json)\n',
      stderr: '',
    });
    expect(deny()).toEqual(['esbuild', 'fsevents', 'lefthook']);
    expect(parsePolicy(readFileSync(policyFile, 'utf8'))).toMatchObject({ ok: true });
    // doctor then reports only the package left to review.
    const findings = runDoctor(directory).findings.filter((finding) => finding.rule === 'lockfile-install-scripts');
    expect(findings.map((finding) => finding.message)).toEqual(['core-js has install scripts that npm will not run because depcurfew.json does not allow it; the package may need them']);
    // --force writes the same file again.
    await exec('init', directory, '--force');
    expect(deny()).toEqual(['esbuild', 'fsevents', 'lefthook']);
  });

  it('gives the same notes with --json, with their lockfile lines', async () => {
    cpSync(KNOWN, directory, { recursive: true });
    rmSync(policyFile);
    const result = await exec('init', directory, '--json');
    const document = JSON.parse(result.stdout) as { notices: { code: string; level: string; location: { file: string; line?: number } }[]; warnings: unknown[] };
    expect(document.warnings).toEqual([]);
    expect(document.notices.map((notice) => [notice.code, notice.level, notice.location])).toEqual([
      ['install-script-denied', 'note', { file: 'package-lock.json', line: 15 }],
      ['install-script-denied', 'note', { file: 'package-lock.json', line: 37 }],
      ['install-script-project-task', 'note', { file: 'package-lock.json', line: 46 }],
      ['install-scripts-to-review', 'note', { file: 'package-lock.json' }],
    ]);
  });

  it('finds them by name in a pnpm-lock.yaml, which records no install scripts, and says so', async () => {
    write({ 'package.json': '{ "name": "app", "packageManager": "pnpm@11.28.10" }\n', 'pnpm-lock.yaml': PNPM_LOCK });
    const result = await exec('init', directory);
    expect(deny()).toEqual(['esbuild', 'lefthook']);
    expect(result.stdout).toContain(
      '  fix: Keep optional dependencies installed, or move esbuild to installScripts.allow in depcurfew.json only if you want its script to run\n',
    );
    expect(result.stdout).toContain(
      '  fix: Run lefthook install after each clone of the repository, as the lefthook documentation says for projects that do not use its postinstall script, or move lefthook to installScripts.allow in depcurfew.json only if you want its script to run\n',
    );
    expect(result.stdout).toContain(
      'note: init cannot tell from pnpm-lock.yaml which packages have install scripts (pnpm does not record install scripts in it), so it names only the packages depcurfew knows, and installScripts.default "deny" blocks the scripts of the others (install-scripts-not-recorded)\n' +
        '  fix: Install once and review the packages whose install scripts pnpm skips or stops at: add each to installScripts.allow in depcurfew.json if it needs them, or to installScripts.deny if it works without them\n',
    );
    // The locked versions are the ones depcurfew checked, so no note about them.
    expect(result.stdout).not.toContain('depcurfew checked');
  });

  // Decision D-135: lefthook's documentation says to run lefthook install after cloning for projects that do not use
  // its postinstall script (which does nothing in CI); a prepare script would run it in CI too. The same advice for
  // every package manager.
  it('tells a project with Bun to run lefthook install after each clone, and one with ignore-scripts=true too', async () => {
    write({
      'package.json': '{ "name": "app" }\n',
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {\n    "lefthook": ["lefthook@2.2.2", "", { "hasInstallScript": true }, "sha512-CCCC"],\n  }\n}\n',
    });
    const bun = await exec('init', directory);
    expect(bun.stdout).toContain('  fix: Run lefthook install after each clone of the repository, as the lefthook documentation says for projects that do not use its postinstall script, or move lefthook to installScripts.allow in depcurfew.json only if you want its script to run\n');
    rmSync(join(directory, 'bun.lock'));
    cpSync(join(KNOWN, 'package-lock.json'), join(directory, 'package-lock.json'));
    write({ '.npmrc': 'ignore-scripts=true\n' });
    const npm = await exec('init', directory, '--force');
    expect(npm.stdout).toContain('  fix: Run lefthook install after each clone of the repository, as the lefthook documentation says for projects that do not use its postinstall script, or move lefthook to installScripts.allow in depcurfew.json only if you want its script to run\n');
    expect(npm.stdout).not.toContain('prepare');
  });

  // Decision D-135: what depcurfew knows about a package holds for that package from a registry only.
  it('gives no hint for a known name from another source, and lists it to review instead', async () => {
    const sha = 'a'.repeat(40);
    const lock = {
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', devDependencies: { lefthook: 'github:evil/lefthook', esbuild: '^0.28.2' } },
        'node_modules/lefthook': { version: '2.2.2', resolved: `${['g', 'i', 't'].join('')}+ssh://${['g', 'i', 't'].join('')}@evil.example/lefthook.${['g', 'i', 't'].join('')}#${sha}`, hasInstallScript: true },
        'node_modules/esbuild': { version: '0.28.2', resolved: 'https://registry.npmjs.org/evil/-/evil-0.28.2.tgz', integrity: 'sha512-AAAA', hasInstallScript: true },
      },
    };
    write({ 'package.json': '{ "name": "app" }\n', 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` });
    const result = await exec('init', directory);
    expect(deny()).toEqual([]);
    expect(result.stdout).not.toContain('install-script-project-task');
    expect(result.stdout).not.toContain('install-script-denied');
    expect(result.stdout).toContain('depcurfew does not know: lefthook and esbuild (install-scripts-to-review)');
    const findings = runDoctor(directory).findings.filter((finding) => finding.rule === 'lockfile-install-scripts');
    expect(findings.map((finding) => finding.message)).toEqual([
      'lefthook has install scripts that npm will not run because depcurfew.json does not allow it; the package may need them',
      'esbuild has install scripts that npm will not run because depcurfew.json does not allow it; the package may need them',
    ]);
  });

  it('names the lockfile and package.json of a project listed under projects', async () => {
    cpSync(KNOWN, join(directory, 'web'), { recursive: true });
    rmSync(join(directory, 'web', 'depcurfew.json'));
    const result = await exec('init', directory);
    expect(deny()).toEqual(['esbuild', 'fsevents', 'lefthook']);
    expect(result.stdout).toContain('note: esbuild in web/package-lock.json has an install script');
    expect(result.stdout).toContain('  fix: Run lefthook install after each clone of the repository, as the lefthook documentation says for projects that do not use its postinstall script, or move lefthook to installScripts.allow in depcurfew.json only if you want its script to run\n');
  });

  it('writes an empty installScripts.deny and says nothing about scripts without a lockfile', async () => {
    write({ 'package.json': '{ "name": "app" }\n' });
    const result = await exec('init', directory);
    expect(deny()).toEqual([]);
    expect(result.stdout).not.toContain('install script');
  });
});
