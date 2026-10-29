// Runs the built executable. `npm test` builds with tsdown before running Vitest.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};
const binPath = fileURLToPath(new URL(pkg.bin['depgate'] ?? '', root));

// Plain output whatever the environment running the tests sets; the color tests set these themselves.
const { FORCE_COLOR: _force, NO_COLOR: _no, ...plainEnv } = process.env;

function depgate(...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: plainEnv });
}

function depgateIn(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', cwd, env: plainEnv });
}

function depgateWith(env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: { ...plainEnv, ...env } });
}

describe('built depgate executable', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`npm test\` (it builds first) or \`npm run build\`.`);
    }
  });

  it('starts with a node shebang', () => {
    expect(readFileSync(binPath, 'utf8').split('\n', 1)[0]).toBe('#!/usr/bin/env node');
  });

  it('--help exits with 0 and prints usage', () => {
    const result = depgate('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: depgate <command> [options]');
  });

  it('prints plain text to a pipe, colors with FORCE_COLOR and none with NO_COLOR', () => {
    const directory = fileURLToPath(new URL('tests/fixtures/doctor/config-drift/fires-hand-edited/repo', root));
    const ansi = /\u001b\[/u;
    expect(depgate('doctor', directory).stdout).not.toMatch(ansi);
    const colored = depgateWith({ FORCE_COLOR: '1' }, 'doctor', directory);
    expect(colored.stdout).toMatch(/\u001b\[1m\u001b\[31merror\u001b\[39m\u001b\[22m/u);
    expect(depgateWith({ FORCE_COLOR: '1' }, 'doctor', '--json', directory).stdout).not.toMatch(ansi);
    expect(depgateWith({ FORCE_COLOR: '1' }, 'doctor', '--sarif', directory).stdout).not.toMatch(ansi);
    expect(depgateWith({ NO_COLOR: '1' }, 'doctor', directory).stdout).not.toMatch(ansi);
    expect(depgateWith({ FORCE_COLOR: '1' }, 'frobnicate').stderr).toMatch(/^\u001b\[31m\u001b\[1mdepgate:/u);
  });

  it('--version prints the package version', () => {
    const result = depgate('--version');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('init writes the default policy into the current directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depgate-e2e-'));
    try {
      const first = depgateIn(directory, 'init');
      expect(first.status).toBe(0);
      expect(first.stdout).toBe('Created depgate.json with the default policy.\nDetected tools: none.\n');
      expect(readFileSync(join(directory, 'depgate.json'), 'utf8')).toBe(
        readFileSync(new URL('tests/fixtures/init/depgate.json', root), 'utf8'),
      );

      const second = depgateIn(directory, 'init');
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('depgate.json already exists; pass --force to overwrite it.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('explain --json describes a fixture repository', () => {
    const result = depgate('explain', '--json', fileURLToPath(new URL('tests/fixtures/repos/npm-basic', root)));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      project: JSON.parse(readFileSync(new URL('tests/fixtures/expected/npm-basic/detect.json', root), 'utf8')),
      policy: null,
    });
  });

  it('apply writes the expected files into a copy of a fixture repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depgate-e2e-'));
    try {
      cpSync(fileURLToPath(new URL('tests/fixtures/repos/pnpm11-dependabot', root)), directory, { recursive: true });
      writeFileSync(join(directory, 'depgate.json'), readFileSync(new URL('tests/fixtures/apply/policy.json', root)));
      const expected = new URL('tests/fixtures/expected/pnpm11-dependabot/after/', root);

      const dryRun = depgateIn(directory, 'apply', '--dry-run');
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain('+++ b/pnpm-workspace.yaml\n');
      expect(dryRun.stderr).toContain('nothing written.\n');

      const result = depgateIn(directory, 'apply');
      expect(result.status).toBe(0);
      for (const file of readdirSync(expected, { recursive: true, encoding: 'utf8' })) {
        if (!statSync(new URL(file, expected)).isFile()) continue;
        expect(readFileSync(join(directory, file), 'utf8'), file).toBe(readFileSync(new URL(file, expected), 'utf8'));
      }
      expect(depgateIn(directory, 'apply').stdout).toBe('Nothing to change; the configuration already matches the policy.\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('apply without a policy exits with 1', () => {
    const result = depgate('apply', fileURLToPath(new URL('tests/fixtures/repos/npm-basic', root)));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run 'depgate init' first");
  });

  it('doctor --sarif reports a fixture repository and fails on its error', () => {
    const result = depgate('doctor', '--sarif', fileURLToPath(new URL('tests/fixtures/doctor/bot-cooldown-mismatch/fires-dependabot-shorter/repo', root)));
    expect(result.status).toBe(1);
    const sarif = JSON.parse(result.stdout) as { version: string; runs: { results: { ruleId: string }[] }[] };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.results.map((entry) => entry.ruleId)).toEqual(['bot-cooldown-mismatch']);
  });

  it('doctor exits with 0 on a clean repository', () => {
    const result = depgate('doctor', fileURLToPath(new URL('tests/fixtures/doctor/bot-cooldown-mismatch/passes-consistent/repo', root)));
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith('No problems found.\n')).toBe(true);
  });

  it('an unknown command exits with 2', () => {
    const result = depgate('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });
});
