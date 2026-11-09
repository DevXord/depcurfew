// Decision D-185 in the command scanner: an npx, npm exec or npm x request whose word may name a program of
// node_modules/.bin is marked `binary`, so that the hook can look for that program; a version, a path, a package or
// workspace option, a command before it on the line that may write files, and a loop leave the mark out.
import { describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';

const marks = (line: string) => scanCommandLine(line).requests.map((request) => `${request.spec}${request.binary === true ? ' binary' : ''}`);

describe('npx requests that may run a program of node_modules/.bin (decision D-185)', () => {
  it.each([
    ['npx vitest run', ['vitest binary']],
    ['npx --yes vitest run', ['vitest binary']],
    ['npx -y tsc --noEmit', ['tsc binary']],
    ['npm exec vitest -- run', ['vitest binary']],
    ['npm x tsc', ['tsc binary']],
    ['npm exec -- vitest run', ['vitest binary']],
    ['cd packages/a && npx vitest', ['vitest binary']],
    ['npx tsc | head -20', ['tsc binary']],
    ['ls node_modules/.bin; npx vitest', ['vitest binary']],
  ])('%s', (line, expected) => {
    expect(marks(line)).toEqual(expected);
  });

  it.each([
    ['npx vitest@1 run', ['vitest@1']],
    ['npx @vitest/ui', ['@vitest/ui']],
    ['npx -p vitest vitest', ['vitest']],
    ['npx --package=vitest vitest', ['vitest']],
    ['npx -w a vitest', ['vitest']],
    ['npx --workspace a vitest', ['vitest']],
    ['npx --ws vitest', ['vitest']],
    ['npx --workspaces vitest', ['vitest']],
    ['npx --iwr vitest', ['vitest']],
    ['npx --include-workspace-root vitest', ['vitest']],
    ['npm exec vitest --workspace=a', ['vitest']],
    ['rm -rf node_modules && npx vitest', ['vitest']],
    ['echo x > out.txt; npx vitest', ['vitest']],
    ['for i in 1 2; do npx vitest; done', ['vitest']],
    ['while true; do npx vitest; done', ['vitest']],
    ['f() { npx vitest; }; f', ['vitest']],
    ['npx vitest; npm install; npx vitest', ['vitest binary', 'vitest']],
    // The first program may write files too: rimraf removes node_modules, and npx then downloads vitest.
    ['npx tsc && npx vitest', ['tsc binary', 'vitest']],
    ['npx rimraf node_modules && npx vitest', ['rimraf binary', 'vitest']],
    ['pnpm dlx vitest', ['vitest']],
    ['bunx vitest', ['vitest']],
    ['npm install vitest', ['vitest']],
  ])('%s', (line, expected) => {
    expect(marks(line)).toEqual(expected);
  });

  it('leaves out words that are not plain program names', () => {
    for (const word of ['./vitest', '../vitest', 'tools/vitest', 'C:vitest', '.vitest', `${'a'.repeat(215)}`, 'vi:test']) {
      expect(scanCommandLine(`npx ${word}`).requests.every((request) => request.binary !== true), word).toBe(true);
    }
    expect(marks(`npx ${'a'.repeat(214)}`)).toEqual([`${'a'.repeat(214)} binary`]);
  });
});
