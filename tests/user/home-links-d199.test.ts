// Decision D-199 (with D-196): linkOutOfHome follows a chain of symbolic links to missing files in the home directory
// for at most 40 links, as the kernel does (ELOOP), and counts a longer chain as leading out of the home directory, so
// apply --user and init --user run as root write nothing through it. Following links needs no privilege, so these
// tests run in the normal suite with process.getuid() returning 0; when the tests really run as root, the home
// directory is given to nobody, since linkOutOfHome only acts for the home directory of another user. POSIX only.
import { chownSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { linkOutOfHome } from '../../src/user/home.ts';
import { windows } from '../support/platform.ts';
import { fakeMachine } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const NOBODY = 65534;

/** ~/.config/pip/pip.conf -> ~/l1 -> ~/l2 -> ... -> ~/missing: `links` symbolic links, none of which leaves home. */
function chain(links: number): { environment: ReturnType<typeof fakeMachine>; pipConf: string } {
  const environment = fakeMachine({}, temporary);
  const { home } = environment;
  if (statSync(home).uid === 0) chownSync(home, NOBODY, NOBODY);
  const pipConf = join(home, '.config', 'pip', 'pip.conf');
  mkdirSync(dirname(pipConf), { recursive: true });
  const names = [pipConf, ...Array.from({ length: links - 1 }, (_, index) => join(home, `l${index + 1}`)), join(home, 'missing')];
  for (let index = 0; index < links; index += 1) symlinkSync(names[index + 1] ?? '', names[index] ?? '');
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  return { environment, pipConf };
}

describe.skipIf(windows)('a chain of links to missing files in the home directory (decisions D-196 and D-199)', () => {
  // So the case of 40 links cannot pass only because linkOutOfHome did not act at all.
  it('finds one link to a missing file outside the home directory in the same setup', () => {
    const { environment, pipConf } = chain(1);
    const outside = join(dirname(environment.home), 'outside');
    rmSync(pipConf);
    symlinkSync(outside, pipConf);
    expect(linkOutOfHome(environment, pipConf)).toEqual({ link: pipConf, target: outside });
  });

  it('stays in the home directory with 40 links, as many as the kernel follows', () => {
    const { environment, pipConf } = chain(40);
    expect(linkOutOfHome(environment, pipConf)).toBeUndefined();
  });

  it('leads out of the home directory with 41 links, so nothing is written through it', () => {
    const { environment, pipConf } = chain(41);
    expect(linkOutOfHome(environment, pipConf)).toMatchObject({ link: pipConf });
  });
});
