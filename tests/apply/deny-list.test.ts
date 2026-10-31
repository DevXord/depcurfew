// installScripts.deny in apply (decision D-085): where a tool records an explicit denial, apply writes it, so the
// tool keeps those scripts blocked without warning about them on every install.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>, deny: string[] = ['fsevents'], allow: string[] = []): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-deny-'));
  temporary.push(directory);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, installScripts: { default: 'deny', allow, deny }, targets: 'auto' }));
  return directory;
}

const json = (directory: string, file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record<string, unknown>;

describe('installScripts.deny in apply', () => {
  it('writes false into allowScripts for npm 11.16 and later, and drops patterns with a warning', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "npm@11.21.1" }\n', 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n' }, ['fsevents', '@types/*']);
    const report = applyProject(directory, { write: true });
    expect(json(directory, 'package.json')['allowScripts']).toEqual({ fsevents: false });
    expect(report.warningDetails.map((warning) => warning.code)).toContain('deny-pattern-unsupported');
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });

  it('writes false into allowBuilds for pnpm', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "pnpm@11.28.10" }\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }, ['fsevents'], ['esbuild']);
    applyProject(directory, { write: true });
    const workspace = readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toMatch(/allowBuilds:\n(?:.*\n)*?\s+esbuild: true\n(?:.*\n)*?\s+fsevents: false\n/u);
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });

  it('writes built: false into dependenciesMeta for Yarn', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "yarn@4.18.1" }\n', 'yarn.lock': '__metadata:\n  version: 8\n' });
    applyProject(directory, { write: true });
    expect(json(directory, 'package.json')['dependenciesMeta']).toEqual({ fsevents: { built: false } });
  });

  it('moves the allow list of deno.json into the object form and adds the denial', () => {
    const directory = project({ 'deno.json': '{\n  "allowScripts": ["npm:esbuild"]\n}\n', 'deno.lock': '{ "version": "5" }\n' });
    applyProject(directory, { write: true });
    expect(json(directory, 'deno.json')['allowScripts']).toEqual({ allow: ['npm:esbuild'], deny: ['npm:fsevents'] });
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });
});
