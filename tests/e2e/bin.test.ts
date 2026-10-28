// Runs the built executable. `npm test` builds with tsdown before running Vitest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function depgate(...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

function depgateIn(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', cwd });
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

  it('an unknown command exits with 2', () => {
    const result = depgate('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });
});
