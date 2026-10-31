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

// Decision D-088: an entry in the tool's own allow or deny list that contradicts installScripts is not changed by
// apply (it may be hand-written); apply and doctor report it with deny-conflicts-with-file instead.
const codesOf = (report: ReturnType<typeof applyProject>) => report.warningDetails.map((warning) => warning.code);
const fixesOf = (report: ReturnType<typeof applyProject>) => report.warningDetails.map((warning) => warning.fix ?? '').join('\n');

describe('installScripts.deny against entries already in the files', () => {
  it('keeps a hand-written npm allowScripts entry for a denied package and reports the conflict', () => {
    const manifest = '{\n  "name": "app",\n  "packageManager": "npm@11.21.1",\n  "allowScripts": {\n    "fsevents": true\n  }\n}\n';
    const directory = project({ 'package.json': manifest, 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n' });
    const report = applyProject(directory, { write: true });
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifest);
    expect(report.warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file')).toEqual([
      {
        code: 'deny-conflicts-with-file',
        tool: 'npm',
        location: { file: 'package.json', line: 5 },
        message:
          'allowScripts in package.json (line 5) lets fsevents run its install scripts, although installScripts.deny in depcurfew.json says they must not run; depcurfew apply does not change entries it did not write',
        fix: 'Remove fsevents from allowScripts in package.json, or move fsevents from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its scripts',
      },
    ]);
    expect(codesOf(report)).not.toContain('allow-list-entry-outside-policy');
    expect(fixesOf(report)).not.toMatch(/add fsevents to installScripts\.allow/u);
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });

  it('keeps a pnpm allowBuilds entry with its comment and reports the conflict', () => {
    const workspace = 'allowBuilds:\n  fsevents: true # needed for the watcher\n';
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "pnpm@11.28.10" }\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': workspace });
    const report = applyProject(directory, { write: true });
    expect(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')).toContain('  fsevents: true # needed for the watcher\n');
    expect(report.warningDetails.find((warning) => warning.code === 'deny-conflicts-with-file')).toMatchObject({
      location: { file: 'pnpm-workspace.yaml', line: 2 },
      fix: 'Remove fsevents from allowBuilds in pnpm-workspace.yaml, or move fsevents from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its scripts',
    });
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });

  it('keeps Yarn dependenciesMeta entries that build a denied package, also version-specific ones, which win over a name-only entry', () => {
    const manifest = '{\n  "name": "app",\n  "packageManager": "yarn@4.18.1",\n  "dependenciesMeta": {\n    "core-js@3.38.1": { "built": true }\n  }\n}\n';
    const directory = project({ 'package.json': manifest, 'yarn.lock': '__metadata:\n  version: 8\n' }, ['core-js', 'fsevents']);
    const report = applyProject(directory, { write: true });
    expect(json(directory, 'package.json')['dependenciesMeta']).toEqual({ 'core-js@3.38.1': { built: true }, fsevents: { built: false } });
    expect(report.warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file').map((warning) => warning.message)).toEqual([
      'dependenciesMeta in package.json (line 5) lets core-js@3.38.1 run its install scripts, although installScripts.deny in depcurfew.json says they must not run; depcurfew apply does not change entries it did not write',
    ]);
  });

  it('reports a Bun trustedDependencies entry for a denied package as a conflict, not as an entry to allow', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "bun@1.4.4", "trustedDependencies": ["fsevents"] }\n', 'bun.lock': '{ "lockfileVersion": 1 }\n' });
    const report = applyProject(directory, { write: false });
    expect(codesOf(report)).toContain('deny-conflicts-with-file');
    expect(codesOf(report)).not.toContain('allow-list-entry-outside-policy');
    expect(fixesOf(report)).not.toMatch(/fsevents to installScripts\.allow/u);
  });

  it('adds an allowed package to deno.json but reports the deny entry that still blocks it, which Deno checks after the allow list', () => {
    const config = '{\n  "allowScripts": {\n    "allow": [],\n    "deny": ["npm:fsevents"]\n  }\n}\n';
    const directory = project({ 'deno.json': config, 'deno.lock': '{ "version": "5" }\n' }, [], ['fsevents']);
    const report = applyProject(directory, { write: true });
    expect(json(directory, 'deno.json')['allowScripts']).toEqual({ allow: ['npm:fsevents'], deny: ['npm:fsevents'] });
    expect(report.warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file')).toEqual([
      {
        code: 'deny-conflicts-with-file',
        tool: 'deno',
        location: { file: 'deno.json', line: 4 },
        message:
          'allowScripts.deny in deno.json (line 4) blocks the install scripts of fsevents, but installScripts.allow in depcurfew.json allows them; depcurfew apply does not change entries it did not write',
        fix: 'Remove fsevents from allowScripts.deny in deno.json, or move fsevents from installScripts.allow to installScripts.deny in depcurfew.json if it works without its scripts',
      },
    ]);
  });

  it('does not add a denial to deno.json for a package its allow list names', () => {
    const directory = project({ 'deno.json': '{\n  "allowScripts": ["npm:fsevents@2.3.3"]\n}\n', 'deno.lock': '{ "version": "5" }\n' });
    const report = applyProject(directory, { write: false });
    expect(report.changes).toEqual([]);
    expect(codesOf(report)).toContain('deny-conflicts-with-file');
  });

  it('warns instead of dropping a deno.json deny value that is not a list', () => {
    const config = '{\n  "allowScripts": { "allow": [], "deny": "npm:x" }\n}\n';
    const directory = project({ 'deno.json': config, 'deno.lock': '{ "version": "5" }\n' });
    const report = applyProject(directory, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.find((warning) => warning.code === 'unexpected-value')).toMatchObject({
      tool: 'deno',
      location: { file: 'deno.json' },
      message: 'Deno: allowScripts.deny in deno.json is not a list, so depcurfew apply does not add npm:fsevents to it',
      fix: 'Write allowScripts.deny in deno.json as a list of npm: specifiers, such as ["npm:x"], then run depcurfew apply again',
    });
  });

  it('names dependenciesMeta, not its template, when a Yarn denial is a pattern', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "yarn@4.18.1" }\n', 'yarn.lock': '__metadata:\n  version: 8\n' }, ['@types/*']);
    const warning = applyProject(directory, { write: false }).warningDetails.find((item) => item.code === 'deny-pattern-unsupported');
    expect(warning?.message).toBe('Yarn (Berry): dependenciesMeta takes package names only; "@types/*" not written');
  });
});

describe('installScripts.deny in pnpm before allowBuilds', () => {
  it('writes ignoredBuiltDependencies into pnpm-workspace.yaml from 10.5.0 to 10.25', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "pnpm@10.20.0" }\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }, ['fsevents'], ['esbuild']);
    applyProject(directory, { write: true });
    const workspace = readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toMatch(/onlyBuiltDependencies:\n\s+- esbuild\n/u);
    expect(workspace).toMatch(/ignoredBuiltDependencies:\n\s+- fsevents\n/u);
    expect(applyProject(directory, { write: false }).changes).toEqual([]);
  });

  it('writes pnpm.ignoredBuiltDependencies into package.json from 10.1.0 to 10.4', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "pnpm@10.2.0" }\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    applyProject(directory, { write: true });
    expect(json(directory, 'package.json')['pnpm']).toEqual({ ignoredBuiltDependencies: ['fsevents'] });
  });

  it('does not list a denied package that onlyBuiltDependencies lets build, and reports the conflict', () => {
    const directory = project({
      'package.json': '{ "name": "app", "packageManager": "pnpm@10.20.0" }\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - fsevents\n',
    });
    const report = applyProject(directory, { write: false });
    expect(report.changes).toEqual([]);
    expect(codesOf(report)).toContain('deny-conflicts-with-file');
  });

  it('says so when the version is too old to record a denial at all', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "pnpm@10.0.0" }\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    const warning = applyProject(directory, { write: false }).warningDetails.find((item) => item.code === 'version-too-old');
    expect(warning?.message).toBe('pnpm 10.0.0 does not support ignoredBuiltDependencies (since 10.1.0); not written');
  });
});
