// Runs the built executable. `npm test` builds with tsdown before running Vitest.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

  it('an unknown command exits with 2', () => {
    const result = depgate('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });
});
