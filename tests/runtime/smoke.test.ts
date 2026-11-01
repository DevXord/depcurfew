// The smoke test CI runs on old Node.js versions (decision D-103) also passes on the Node.js running the tests.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('runtime smoke test', () => {
  it('passes on this Node.js', () => {
    const script = fileURLToPath(new URL('smoke.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.stdout).toContain('every step passed');
    expect(result.status).toBe(0);
  }, 60_000);
});
