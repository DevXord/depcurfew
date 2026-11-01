// Installed versions read from files next to the executable in PATH, without running anything (decision D-087).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bun } from '../../src/knowledge/bun.ts';
import { pdm } from '../../src/knowledge/pdm.ts';
import { poetry } from '../../src/knowledge/poetry.ts';
import { yarn } from '../../src/knowledge/yarn.ts';
import { findExecutable, installedVersion, libraryVersion, toolVersion } from '../../src/user/versions.ts';
import { canSymlink } from '../support/platform.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-versions-'));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

/** An environment on this machine's platform whose PATH is one temporary folder. */
const linux = (path: string) => ({ platform, home: tmpdir(), env: { PATH: path } });

describe('installedVersion', () => {
  it.skipIf(!canSymlink())('reads npm from the package.json behind the symlink in the prefix bin folder', () => {
    const root = scratch({
      'lib/node_modules/npm/bin/npm-cli.js': '#!/usr/bin/env node\n',
      'lib/node_modules/npm/package.json': JSON.stringify({ name: 'npm', version: '11.21.1', bin: { npm: 'bin/npm-cli.js', npx: 'bin/npx-cli.js' } }),
    });
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(root, 'lib/node_modules/npm/bin/npm-cli.js'), join(root, 'bin', 'npm'));
    const found = installedVersion('npm', 'npm', linux(join(root, 'bin')));
    expect(found?.text).toBe('11.21.1');
    expect(found?.version).toEqual([11, 21, 1]);
  });

  it('reads a shim that is not a symlink (as npm writes on Windows) from node_modules next to it', () => {
    const root = scratch({
      'pnpm': '#!/bin/sh\n',
      'node_modules/pnpm/package.json': JSON.stringify({ name: 'pnpm', version: '11.28.10', bin: { pnpm: 'bin/pnpm.cjs', pnpx: 'bin/pnpx.cjs' } }),
    });
    expect(installedVersion('pnpm', 'npm', linux(root))?.text).toBe('11.28.10');
  });

  it.skipIf(process.platform !== 'win32')('finds pnpm.cmd in Path on Windows', () => {
    const root = scratch({ 'pnpm.cmd': '@ECHO off\n' });
    expect(findExecutable('pnpm', { platform: 'win32', home: 'C:\\Users\\Ada', env: { Path: root } })).toBe(join(root, 'pnpm.cmd'));
  });

  it('ignores a package.json that does not declare the executable', () => {
    const root = scratch({
      'bin/npm': '#!/bin/sh\n',
      'package.json': JSON.stringify({ name: 'npm-helper', version: '0.1.0', bin: { 'npm-helper': 'bin/helper.js' } }),
    });
    expect(installedVersion('npm', 'npm', linux(join(root, 'bin')))).toBeUndefined();
  });

  // The bin list of corepack 0.34.0 as published (publishConfig.bin in its package.json): its shims are not the tools.
  const COREPACK = { name: 'corepack', version: '0.34.0', bin: { corepack: './dist/corepack.js', pnpm: './dist/pnpm.js', pnpx: './dist/pnpx.js', yarn: './dist/yarn.js', yarnpkg: './dist/yarnpkg.js' } };

  it.skipIf(!canSymlink())('leaves the version of a corepack shim unknown instead of reading corepack\'s own', () => {
    const root = scratch({
      'lib/node_modules/corepack/dist/pnpm.js': '#!/usr/bin/env node\n',
      'lib/node_modules/corepack/dist/yarn.js': '#!/usr/bin/env node\n',
      'lib/node_modules/corepack/package.json': JSON.stringify(COREPACK),
    });
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(root, 'lib/node_modules/corepack/dist/pnpm.js'), join(root, 'bin', 'pnpm'));
    symlinkSync(join(root, 'lib/node_modules/corepack/dist/yarn.js'), join(root, 'bin', 'yarn'));
    expect(installedVersion('pnpm', 'npm', linux(join(root, 'bin')))).toBeUndefined();
    expect(installedVersion('yarn', 'npm', linux(join(root, 'bin')))).toBeUndefined();
  });

  it('leaves a corepack shim next to node_modules unknown, and reads a scoped package of the tool (@pnpm/exe)', () => {
    const shim = scratch({ pnpm: '#!/bin/sh\n', 'node_modules/pnpm/package.json': JSON.stringify(COREPACK) });
    expect(installedVersion('pnpm', 'npm', linux(shim))).toBeUndefined();
    const exe = scratch({
      'lib/node_modules/@pnpm/exe/pnpm': 'binary',
      'lib/node_modules/@pnpm/exe/package.json': JSON.stringify({ name: '@pnpm/exe', version: '10.28.0', bin: { pnpm: 'pnpm' } }),
    });
    expect(installedVersion('pnpm', 'npm', linux(join(exe, 'lib/node_modules/@pnpm/exe')))?.text).toBe('10.28.0');
  });

  it('reads a Python tool from the .dist-info that declares its script', () => {
    const root = scratch({
      'bin/uv': 'binary',
      'lib/python3.12/site-packages/uv-0.13.6.dist-info/METADATA': 'Metadata-Version: 2.4\nName: uv\nVersion: 0.13.6\n',
      'lib/python3.12/site-packages/uv-0.13.6.dist-info/RECORD': '../../../bin/uv,sha256=abc,123\nuv/__init__.py,,\n',
      'lib/python3.12/site-packages/pip-26.2.2.dist-info/METADATA': 'Name: pip\nVersion: 26.2.2\n',
      'lib/python3.12/site-packages/pip-26.2.2.dist-info/entry_points.txt': '[console_scripts]\npip = pip._internal.cli.main:main\npip3 = pip._internal.cli.main:main\n',
      'bin/pip': '#!/usr/bin/python3\n',
    });
    expect(installedVersion('uv', 'pypi', linux(join(root, 'bin')))?.text).toBe('0.13.6');
    expect(installedVersion('pip', 'pypi', linux(join(root, 'bin')))?.text).toBe('26.2.2');
  });

  it('reads a Python tool that Debian or Ubuntu installed into dist-packages', () => {
    const root = scratch({
      'bin/pip': '#!/usr/bin/python3\n',
      'lib/python3/dist-packages/pip-24.0.dist-info/METADATA': 'Name: pip\nVersion: 24.0\n',
      'lib/python3/dist-packages/pip-24.0.dist-info/entry_points.txt': '[console_scripts]\npip = pip._internal.cli.main:main\n',
    });
    expect(installedVersion('pip', 'pypi', linux(join(root, 'bin')))?.text).toBe('24.0');
  });

  it('stays unknown for a binary without metadata and for a tool that is not in PATH', () => {
    const root = scratch({ 'bin/bun': 'binary' });
    expect(installedVersion('bun', 'npm', linux(join(root, 'bin')))).toBeUndefined();
    expect(installedVersion('pnpm', 'npm', linux(join(root, 'bin')))).toBeUndefined();
    expect(installedVersion('npm', 'npm', linux('relative/bin'))).toBeUndefined();
  });
});

// Yarn and Bun without npm's own package, read from files only (decision D-101).
describe('Yarn and Bun versions from files', () => {
  const COREPACK = { name: 'corepack', version: '0.36.0', bin: { corepack: './dist/corepack.js', pnpm: './dist/pnpm.js', pnpx: './dist/pnpx.js', yarn: './dist/yarn.js', yarnpkg: './dist/yarnpkg.js' } };

  /** A PATH with corepack's yarn shim, as corepack enable links it, and a home directory. */
  function corepackMachine(files: Record<string, string> = {}): { root: string; home: string; bin: string } {
    const root = scratch({
      'lib/node_modules/corepack/dist/yarn.js': '#!/usr/bin/env node\n',
      'lib/node_modules/corepack/package.json': JSON.stringify(COREPACK),
      'home/.keep': '',
      ...files,
    });
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(root, 'lib/node_modules/corepack/dist/yarn.js'), join(root, 'bin', 'yarn'));
    return { root, home: join(root, 'home'), bin: join(root, 'bin') };
  }

  it.skipIf(!canSymlink())('reads Yarn installed with npm i -g @yarnpkg/cli-dist, whose package is not named yarn', () => {
    const root = scratch({
      'lib/node_modules/@yarnpkg/cli-dist/bin/yarn.js': '#!/usr/bin/env node\n',
      'lib/node_modules/@yarnpkg/cli-dist/package.json': JSON.stringify({ name: '@yarnpkg/cli-dist', version: '4.18.1', bin: { yarn: 'bin/yarn.js', yarnpkg: 'bin/yarn.js' } }),
    });
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(root, 'lib/node_modules/@yarnpkg/cli-dist/bin/yarn.js'), join(root, 'bin', 'yarn'));
    expect(installedVersion('yarn', 'npm', linux(join(root, 'bin')))).toMatchObject({ text: '4.18.1', version: [4, 18, 1] });
  });

  it.skipIf(!canSymlink() || process.platform === 'win32')('reads the version a Corepack shim runs outside a project from lastKnownGood.json, without its hash', () => {
    const machine = corepackMachine({ 'home/.cache/node/corepack/lastKnownGood.json': JSON.stringify({ yarn: '4.18.1+sha224.5707fce90df5d8720fae4e85a07ab55e90aa20fded8914893e2ba225', pnpm: '11.28.10' }) });
    const environment = { platform, home: machine.home, env: { PATH: machine.bin } };
    expect(toolVersion(yarn, environment)).toMatchObject({ text: '4.18.1', from: '~/.cache/node/corepack/lastKnownGood.json' });
  });

  it.skipIf(!canSymlink())('looks in COREPACK_HOME, then XDG_CACHE_HOME/node/corepack, as Corepack\'s code does', () => {
    const machine = corepackMachine({
      'corepack-home/lastKnownGood.json': JSON.stringify({ yarn: '4.17.0' }),
      'cache/node/corepack/lastKnownGood.json': JSON.stringify({ yarn: '4.16.0' }),
    });
    const base = { platform, home: machine.home };
    expect(toolVersion(yarn, { ...base, env: { PATH: machine.bin, COREPACK_HOME: join(machine.root, 'corepack-home'), XDG_CACHE_HOME: join(machine.root, 'cache') } })?.text).toBe('4.17.0');
    expect(toolVersion(yarn, { ...base, env: { PATH: machine.bin, XDG_CACHE_HOME: join(machine.root, 'cache') } })?.text).toBe('4.16.0');
  });

  it.skipIf(!canSymlink())('leaves a Corepack shim unknown without lastKnownGood.json, without a yarn entry, and with a relative or empty COREPACK_HOME', () => {
    const machine = corepackMachine({ 'cache/node/corepack/lastKnownGood.json': JSON.stringify({ pnpm: '11.28.10' }), 'bad/lastKnownGood.json': '{"yarn": 4' });
    const env = (extra: Record<string, string>) => ({ platform, home: machine.home, env: { PATH: machine.bin, ...extra } });
    expect(toolVersion(yarn, env({}))).toBeUndefined();
    expect(toolVersion(yarn, env({ XDG_CACHE_HOME: join(machine.root, 'cache') }))).toBeUndefined();
    expect(toolVersion(yarn, env({ COREPACK_HOME: join(machine.root, 'bad') }))).toBeUndefined();
    expect(toolVersion(yarn, env({ COREPACK_HOME: 'relative/home' }))).toBeUndefined();
    // Corepack takes an empty COREPACK_HOME as it is (??), a folder relative to where it runs.
    expect(toolVersion(yarn, env({ COREPACK_HOME: '', XDG_CACHE_HOME: join(machine.root, 'cache') }))).toBeUndefined();
  });

  /** Yarn from npm (a package.json next to the executable) with a home directory holding `files`. */
  function yarnMachine(version: string, files: Record<string, string>): { platform: NodeJS.Platform; home: string; env: Record<string, string> } {
    const root = scratch({ 'bin/yarn': '#!/bin/sh\n', 'bin/node_modules/yarn/package.json': JSON.stringify({ name: 'yarn', version, bin: { yarn: 'bin/yarn.js' } }), 'home/.keep': '', ...files });
    return { platform, home: join(root, 'home'), env: { PATH: join(root, 'bin') } };
  }

  it('takes the version from the file name of yarnPath in ~/.yarnrc.yml (yarn set version) and says where it came from', () => {
    const environment = yarnMachine('4.18.1', { 'home/.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.10.3.cjs\n', 'home/.yarn/releases/yarn-4.10.3.cjs': '// bundle\n' });
    expect(toolVersion(yarn, environment)).toMatchObject({ text: '4.10.3', version: [4, 10, 3], from: 'yarnPath in ~/.yarnrc.yml' });
  });

  it('ignores yarnPath for a name without an exact version, a missing file, a variable that changes it, and Yarn Classic', () => {
    const named = yarnMachine('4.18.1', { 'home/.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-remote.cjs\n', 'home/.yarn/releases/yarn-remote.cjs': '' });
    expect(toolVersion(yarn, named)?.text).toBe('4.18.1');
    const missing = yarnMachine('4.18.1', { 'home/.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.10.3.cjs\n' });
    expect(toolVersion(yarn, missing)?.text).toBe('4.18.1');
    const files = { 'home/.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.10.3.cjs\n', 'home/.yarn/releases/yarn-4.10.3.cjs': '' };
    const ignored = yarnMachine('4.18.1', files);
    expect(toolVersion(yarn, { ...ignored, env: { ...ignored.env, yarn_ignore_path: '1' } })?.text).toBe('4.18.1');
    expect(toolVersion(yarn, yarnMachine('1.22.22', files))?.text).toBe('1.22.22');
  });

  it.skipIf(!canSymlink())('reads Bun installed from npm, whose postinstall leaves the binary as bin/bun.exe', () => {
    const root = scratch({
      'lib/node_modules/bun/bin/bun.exe': 'binary',
      'lib/node_modules/bun/package.json': JSON.stringify({ name: 'bun', version: '1.4.4', bin: { bun: 'bin/bun.exe', bunx: 'bin/bunx.exe' } }),
    });
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(root, 'lib/node_modules/bun/bin/bun.exe'), join(root, 'bin', 'bun'));
    expect(toolVersion(bun, linux(join(root, 'bin')))?.text).toBe('1.4.4');
  });

  it('leaves Bun from the official installer unknown: ~/.bun/bin/bun has no version file next to it', () => {
    const root = scratch({ '.bun/bin/bun': 'binary' });
    expect(toolVersion(bun, linux(join(root, '.bun', 'bin')))).toBeUndefined();
  });
});

describe('libraryVersion', () => {
  it('reads platformdirs from the site-packages of Poetry and PDM', () => {
    const root = scratch({
      'bin/poetry': '#!/usr/bin/python3\n',
      'lib/python3.13/site-packages/poetry-2.5.1.dist-info/METADATA': 'Name: poetry\nVersion: 2.5.1\n',
      'lib/python3.13/site-packages/poetry-2.5.1.dist-info/entry_points.txt': '[console_scripts]\npoetry = poetry.console.application:main\n',
      'lib/python3.13/site-packages/platformdirs-4.14.2.dist-info/METADATA': 'Metadata-Version: 2.4\nName: platformdirs\nVersion: 4.14.2\n',
    });
    const environment = linux(join(root, 'bin'));
    expect(libraryVersion(poetry, 'platformdirs', environment)?.text).toBe('4.14.2');
    expect(libraryVersion(pdm, 'platformdirs', environment)).toBeUndefined();
  });
});

