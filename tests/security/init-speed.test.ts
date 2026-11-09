// init looks for case twins among thousands of project directories in linear time (decision D-163). Before, every
// listable directory was compared with every twin and every directory left out: proposedProjects took 18 s for 64,000
// directories in pairs of case twins on the machine of the measurements, 2.6 s after the fix (most of it to stat the
// directories). Here the names come without directories; the limit leaves a wide margin for slow CI machines.
import { describe, expect, it } from 'vitest';
import { cpuNow } from '../support/cpu-time.ts';
import { caseTwins } from '../../src/cli/init-projects.ts';

describe('init with many case twins', () => {
  it('chooses among 300,000 directory names, 100,000 of them refused, in well under 2 s', () => {
    const pairs = 100_000;
    const names: string[] = [];
    for (let index = 0; index < pairs; index++) names.push(`P${index}`, `p${index}`);
    for (let index = 0; index < pairs; index++) names.push(`own${index}`);
    const refused = new Set(names.filter((name) => name.startsWith('own')));
    const start = cpuNow();
    const { listed, twins } = caseTwins(
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      refused,
    );
    expect(cpuNow() - start).toBeLessThan(2000);
    expect(listed).toHaveLength(pairs);
    expect(listed.every((name) => name.startsWith('P'))).toBe(true);
    expect(twins).toHaveLength(pairs);
    expect(twins.find((twin) => twin.project === 'p1')?.reason).toContain('its name differs from "P1" only in case');
  });
});
