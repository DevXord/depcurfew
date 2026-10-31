// Installed versions read from files next to the executable in PATH, without running anything (decision D-087).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findExecutable, installedVersion } from '../../src/user/versions.ts';
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
