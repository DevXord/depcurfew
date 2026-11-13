// Cargo as a package manager and the Rust version of rust-toolchain and rust-toolchain.toml (E06). Cargo.toml or
// Cargo.lock make Cargo a package manager of the directory; the toolchain file is read as rustup 1.29.3 reads it: when
// both files are there, rust-toolchain wins; rust-toolchain may hold a bare channel name, rust-toolchain.toml only TOML.
// X.Y.Z is that version, X.Y stays as written (the latest X.Y.z), stable is the latest Rust the knowledge base knows,
// with the channel kept, and any other channel (beta, nightly, a date, a custom toolchain) is a version depcurfew
// cannot read, with the reason.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CARGO_TOML = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e06-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  return root;
}

function cargo(files: Record<string, string>) {
  return detectProject(repository(files)).packageManagers.find((manager) => manager.id === 'cargo');
}

describe('Cargo as a package manager (E06)', () => {
  it('is found from Cargo.toml or Cargo.lock', () => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML })?.evidence).toEqual([{ kind: 'config', file: 'Cargo.toml' }]);
    expect(cargo({ 'Cargo.lock': 'version = 4\n' })?.evidence).toEqual([{ kind: 'lockfile', file: 'Cargo.lock' }]);
    expect(cargo({ 'package.json': '{}' })).toBeUndefined();
  });

  it('is supported, with no version when nothing names one', () => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML, 'Cargo.lock': 'version = 4\n' })).toMatchObject({ supported: true, versions: [] });
  });
});

describe('the Rust version of the toolchain file (E06)', () => {
  it.each([
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n', { version: '1.85.0', source: 'tool-config', file: 'rust-toolchain.toml', line: 2 }],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.100.0-x86_64-unknown-linux-gnu"\n', { version: '1.100.0', source: 'tool-config', file: 'rust-toolchain.toml', line: 2, channel: '1.100.0-x86_64-unknown-linux-gnu' }],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.85"\n', { version: '1.85', source: 'tool-config', file: 'rust-toolchain.toml', line: 2 }],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n', { version: '1.100.0', source: 'tool-config', file: 'rust-toolchain.toml', line: 2, channel: 'stable' }],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.100.0-beta.3"\n', { version: '1.100.0-beta.3', source: 'tool-config', file: 'rust-toolchain.toml', line: 2 }],
    ['rust-toolchain', '1.85.0\n', { version: '1.85.0', source: 'tool-config', file: 'rust-toolchain', line: 1 }],
    ['rust-toolchain', '[toolchain]\nchannel = "1.86.0"\n', { version: '1.86.0', source: 'tool-config', file: 'rust-toolchain', line: 2 }],
  ])('reads %s with %j', (file, text, declaration) => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML, [file]: text })?.versions).toEqual([declaration]);
  });

  it.each([
    ['nightly-2026-01-01', 'the rustup channel nightly-2026-01-01 names no Rust release'],
    ['beta', 'the rustup channel beta names no Rust release'],
    ['my-custom-toolchain', 'my-custom-toolchain is a custom rustup toolchain, whose Rust version depcurfew cannot tell'],
  ])('keeps %s as written, with why depcurfew cannot read the version', (channel, unknown) => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML, 'rust-toolchain': `${channel}\n` })?.versions).toEqual([{ version: channel, source: 'tool-config', file: 'rust-toolchain', line: 1, unknown }]);
  });

  it('takes rust-toolchain when both files are in the directory, as rustup does', () => {
    const versions = cargo({ 'Cargo.toml': CARGO_TOML, 'rust-toolchain': '1.85.0\n', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.100.0"\n' })?.versions;
    expect(versions).toEqual([{ version: '1.85.0', source: 'tool-config', file: 'rust-toolchain', line: 1 }]);
  });

  it('does not read a bare channel name in rust-toolchain.toml, which rustup refuses', () => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML, 'rust-toolchain.toml': '1.85.0\n' })?.versions).toEqual([
      { version: '1.85.0', source: 'tool-config', file: 'rust-toolchain.toml', line: 1, unknown: 'rustup reads rust-toolchain.toml as TOML only, and this one is not TOML with [toolchain] channel' },
    ]);
  });

  it('reads no version from a toolchain file without a channel (a path toolchain)', () => {
    expect(cargo({ 'Cargo.toml': CARGO_TOML, 'rust-toolchain.toml': '[toolchain]\npath = "/opt/rust"\n' })?.versions).toEqual([]);
  });

  it('reads no toolchain file without Cargo', () => {
    const detection = detectProject(repository({ 'package.json': '{}', 'rust-toolchain': '1.85.0\n' }));
    expect(detection.packageManagers.find((manager) => manager.id === 'cargo')).toBeUndefined();
  });
});
