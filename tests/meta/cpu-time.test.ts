// The clock of the time limits (tests/support/cpu-time.ts): CPU time of this process, which grows with work and not
// while the process waits, so that a busy CI runner does not fail a limit the code meets.
import { describe, expect, it } from 'vitest';
import { cpuNow } from '../support/cpu-time.ts';

describe('cpuNow', () => {
  it('grows while the process works', () => {
    const start = cpuNow();
    let sum = 0;
    for (let index = 0; index < 20_000_000; index++) sum += index % 7;
    expect(sum).toBeGreaterThan(0);
    expect(cpuNow() - start).toBeGreaterThan(5);
  });

  it('hardly grows while the process waits', async () => {
    const start = cpuNow();
    const clock = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(performance.now() - clock).toBeGreaterThanOrEqual(290);
    expect(cpuNow() - start).toBeLessThan(150);
  });
});
