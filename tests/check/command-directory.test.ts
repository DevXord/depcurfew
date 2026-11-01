// The directory each install of a command runs in (decision D-118): cd, pushd and popd of POSIX shells, PowerShell's
// Set-Location, Push-Location and Pop-Location, cmd's cd, their scope (subshells, sh -c, loops, functions) and the
// options and variables of package managers that move one command (npm --prefix, pnpm --dir, yarn --cwd, bun --cwd,
// uv --directory and --project, poetry -C and -P, pdm -p).
import { describe, expect, it } from 'vitest';
import { scanCommandLine, unreadableFix, unknownDirectory, type CommandDirectory, type KnownDirectory, type ScanOptions } from '../../src/check/command.ts';

/** Each request as tool:spec with its directory (undefined: the directory the command starts in). */
const where = (line: string, options?: ScanOptions) => scanCommandLine(line, options).requests.map((request) => [`${request.tool}:${request.spec}`, request.directory]);
const steps = (...list: string[]): CommandDirectory => ({ steps: list });
/** Directories the shell changes to, which the hook checks exist (decision D-119). */
const entered = (...list: string[]): KnownDirectory => ({ steps: list, entered: list.map((_, index) => index) });
const unknown = (text: string) => ({ unknown: expect.stringContaining(text) as string });
/** Back where it started, after leaving these directories, which must have been entered (decision D-123). */
const back = (...left: KnownDirectory[]): CommandDirectory => ({ steps: [], assumes: left });

describe('the scanner follows cd, pushd and popd', () => {
  it.each([
    ['cd pkgs/strict && npm install @types/node@26.6.6', [['npm:@types/node@26.6.6', entered('pkgs/strict')]]],
    ['cd "pkgs/strict"; npm i x', [['npm:x', entered('pkgs/strict')]]],
    ["cd 'my dir' || exit 1\nnpm i x", [['npm:x', entered('my dir')]]],
    ['cd /srv/app\nnpm i x', [['npm:x', entered('/srv/app')]]],
    ['cd a && cd b && npm i x', [['npm:x', entered('a', 'b')]]],
    ['cd -L a && npm i x', [['npm:x', entered('a')]]],
    ['cd -- a && npm i x', [['npm:x', entered('a')]]],
    ['command cd a && npm i x', [['npm:x', entered('a')]]],
    ['pushd a && npm i x', [['npm:x', entered('a')]]],
    ['pushd a >/dev/null; popd; npm i x', [['npm:x', back(entered('a'))]]],
    ['cd a && cd - && npm i x', [['npm:x', back(entered('a'))]]],
    ['cd a && cd b && cd - && npm i x', [['npm:x', { ...entered('a'), assumes: [entered('a', 'b')] }]]],
    ['pushd a && pushd b && popd && npm i x', [['npm:x', { ...entered('a'), assumes: [entered('a', 'b')] }]]],
    ['cd a && npm i x && cd ../b && npm i y', [['npm:x', entered('a')], ['npm:y', entered('a', '../b')]]],
    ['{ cd a; } && npm i x', [['npm:x', entered('a')]]],
    ["eval 'cd a' && npm i x", [['npm:x', entered('a')]]],
    ["alias go='cd app && npm'\ngo i x", [['npm:x', entered('app')]]],
    ['if true; then cd a && npm i x; fi', [['npm:x', entered('a')]]],
    ['cd a && bash -c "cd b && npm i x"', [['npm:x', entered('a', 'b')]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('ends the scope of a cd with its subshell, its command substitution and its sh -c string', () => {
    expect(where('(cd web && pnpm add react) && yarn add vue')).toEqual([
      ['pnpm:react', entered('web')],
      ['yarn:vue', undefined],
    ]);
    expect(where('echo $(cd a) && npm i y')).toEqual([['npm:y', undefined]]);
    expect(where('x=$(cd a && npm i b) && npm i y')).toEqual([
      ['npm:b', entered('a')],
      ['npm:y', undefined],
    ]);
    expect(where("sh -c 'cd a && npm i x' && npm i y")).toEqual([
      ['npm:x', entered('a')],
      ['npm:y', undefined],
    ]);
    expect(where('bash -c "cd a"; npm i y')).toEqual([['npm:y', undefined]]);
    // A command in the background or in a pipeline does not run in the shell that runs the next one.
    expect(where('cd a & npm i y')).toEqual([['npm:y', undefined]]);
    // sudo cannot run cd, a builtin of the shell, so the directory stays.
    expect(where('sudo cd a; npm i y')).toEqual([['npm:y', undefined]]);
    expect(where('coproc cd a; npm i y')).toEqual([['npm:y', undefined]]);
    // bash's reserved word time runs it in the shell itself.
    expect(where('time cd a; npm i y')).toEqual([['npm:y', entered('a')]]);
    // A { … } group in a pipeline runs in a subshell: the change holds inside it only.
    expect(where('{ cd a && npm i x; } | tee log; npm i y')).toEqual([
      ['npm:x', entered('a')],
      ['npm:y', undefined],
    ]);
  });

  it.each([
    ['cd && npm i x', 'goes to the home directory'],
    ['cd ~ && npm i x', 'goes to the home directory'],
    ['cd ~/p && npm i x', 'is relative to a home directory'],
    ['cd "$DIR" && npm i x', 'the shell expands the directory of "cd $DIR"'],
    ['cd "$(git rev-parse --show-toplevel)/app" && npm i x', 'the shell expands the directory'],
    ['cd pkg* && npm i x', 'the shell expands the directory of "cd pkg*"'],
    ['cd - && npm i x', 'goes back to a directory from before this command'],
    ['popd && npm i x', 'goes back to a directory from before this command'],
    ['pushd && npm i x', 'swaps with a directory from before this command'],
    ['cd a b && npm i x', 'depcurfew does not read'],
    ['cd -x a && npm i x', 'depcurfew does not read'],
    ['cd a | cat; npm i x', 'runs in a pipeline'],
    ['CDPATH=/srv cd a && npm i x', 'CDPATH'],
    ['for d in a b; do npm i x; cd a; done', 'runs in a loop'],
    ['while true; do cd a && npm i x; done', 'runs in a loop'],
    ['f() { cd a; }; f; npm i x', 'runs in a function'],
    // The message quotes the command, not the function header before it.
    ['function f { cd a; }; f; npm i x', '"cd a" runs in a function'],
    ['f() { npm i x; }; cd a; f', 'runs where the function is called'],
    ['if [ -d a ]; then cd a; fi; npm i x', 'runs only in one branch'],
    ['case "$1" in a) cd a;; esac; npm i x', 'runs only in one branch'],
  ])('%s: the directory is unknown', (line, reason) => {
    expect(where(line)).toEqual([['npm:x', unknown(reason)]]);
  });

  it('says which install it cannot place and what to do', () => {
    const scan = scanCommandLine('cd "$DIR" && npm install lodash');
    const directory = scan.requests[0]?.directory;
    expect(directory !== undefined && 'unknown' in directory).toBe(true);
    const text = unknownDirectory(scan.requests[0]?.command ?? '', directory !== undefined && 'unknown' in directory ? directory.unknown : '');
    expect(text).toBe('depcurfew cannot tell which directory "npm install lodash" runs in: the shell expands the directory of "cd $DIR"');
    expect(unreadableFix(text)).toBe(
      'Run the install from that directory, or change to it with a path written out (cd path/to/project && …), so depcurfew checks it with the policy that applies there',
    );
  });

  it('stays silent about commands that install nothing', () => {
    for (const line of ['cd "$DIR" && ls', 'cd ~ && git status', 'for d in */; do (cd "$d" && make); done', 'cd - && npm test']) {
      expect(scanCommandLine(line)).toEqual({ requests: [], unreadable: undefined });
    }
  });

  it('gives overrides the directory of their command', () => {
    expect(scanCommandLine('cd a && npm ci --ignore-scripts=false').overrides).toEqual([
      expect.objectContaining({ written: '--ignore-scripts=false', directory: entered('a') }),
    ]);
    expect(scanCommandLine('npm ci --ignore-scripts=false').overrides?.[0]?.directory).toBeUndefined();
  });
});

describe('the scanner follows the options that move one command', () => {
  it.each([
    ['npm --prefix sub install x', [['npm:x', { steps: ['sub'], localPrefix: true }]]],
    ['npm -C sub i x', [['npm:x', { steps: ['sub'], localPrefix: true }]]],
    ['npm i x --prefix=sub', [['npm:x', { steps: ['sub'], localPrefix: true }]]],
    ['cd a && npm --prefix b i x', [['npm:x', { steps: ['a', 'b'], localPrefix: true, entered: [0] }]]],
    ['pnpm -C sub add x', [['pnpm:x', steps('sub')]]],
    ['pnpm --dir sub add x', [['pnpm:x', steps('sub')]]],
    ['pnpm add x --dir=sub', [['pnpm:x', steps('sub')]]],
    ['yarn --cwd sub add x', [['yarn:x', steps('sub')]]],
    ['yarn --cwd=sub add x', [['yarn:x', steps('sub')]]],
    ['yarn add x --cwd sub', [['yarn:x', steps('sub')]]],
    ['bun add x --cwd sub', [['bun:x', steps('sub')]]],
    ['bun add --cwd=sub x', [['bun:x', steps('sub')]]],
    ['uv --directory sub add requests', [['uv:pypi:requests', steps('sub')]]],
    ['uv add --project sub requests', [['uv:pypi:requests', steps('sub')]]],
    ['uv --directory a --project b add requests', [['uv:pypi:requests', steps('a', 'b')]]],
    ['uv pip install --directory sub requests', [['uv:pypi:requests', steps('sub')]]],
    ['uv pip install --project sub requests', [['uv:pypi:requests', undefined]]],
    ['UV_PROJECT=sub uv add requests', [['uv:pypi:requests', steps('sub')]]],
    ['UV_WORKING_DIR=a uv add --project b requests', [['uv:pypi:requests', steps('a', 'b')]]],
    ['poetry -C sub add requests', [['poetry:pypi:requests', steps('sub')]]],
    ['poetry add requests --directory sub', [['poetry:pypi:requests', steps('sub')]]],
    ['poetry -P sub add requests', [['poetry:pypi:requests', steps('sub')]]],
    ['pdm add -p sub requests', [['pdm:pypi:requests', steps('sub')]]],
    ['PDM_PROJECT=sub pdm add requests', [['pdm:pypi:requests', steps('sub')]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('does not take a directory option of another tool, or a variable set elsewhere on the line, for its own', () => {
    // uv's -C is --config-setting.
    expect(where('uv pip install -C key=value requests')).toEqual([['uv:pypi:requests', undefined]]);
    expect(where('export UV_PROJECT=sub; uv add requests')).toEqual([['uv:pypi:requests', unknown('UV_PROJECT')]]);
    // A directory the shell expands is an option that cannot be read, as before.
    expect(scanCommandLine('npm --prefix "$D" i x').unreadable).toContain('is expanded by the shell');
  });
});

describe('PowerShell and cmd change directories too', () => {
  const powerShell: ScanOptions = { shell: 'powershell' };

  it.each([
    ['cd pkgs/strict; npm i x', [['npm:x', entered('pkgs/strict')]]],
    ['Set-Location -Path pkgs/strict; npm i x', [['npm:x', entered('pkgs/strict')]]],
    ["Set-Location -LiteralPath 'a[1]'; npm i x", [['npm:x', entered('a[1]')]]],
    ['sl a; npm i x', [['npm:x', entered('a')]]],
    ['chdir a; npm i x', [['npm:x', entered('a')]]],
    ['set-location -path:a -PassThru; npm i x', [['npm:x', entered('a')]]],
    ['cd a && npm i x', [['npm:x', entered('a')]]],
    ['cd..; npm i x', [['npm:x', entered('..')]]],
    ['Push-Location a; npm i x; Pop-Location; npm i y', [['npm:x', entered('a')], ['npm:y', back(entered('a'))]]],
    ['pushd a; popd; npm i y', [['npm:y', back(entered('a'))]]],
    ['Push-Location; cd a; popd; npm i y', [['npm:y', back(entered('a'))]]],
  ])('%s', (line, expected) => {
    expect(where(line, powerShell)).toEqual(expected);
  });

  it.each([
    ['cd -; npm i x', 'goes back to a directory from before this command'],
    ['Set-Location; npm i x', 'goes to the home directory'],
    ['cd ~; npm i x', 'goes to the home directory'],
    ['cd $env:TEMP; npm i x', 'the shell expands the directory'],
    ['Set-Location -Path pkg*; npm i x', 'wildcard'],
    ['Set-Location -StackName s; npm i x', 'depcurfew does not read'],
    ['cd Env:; npm i x', 'depcurfew does not read'],
    ['Pop-Location; npm i x', 'goes back to a directory from before this command'],
  ])('%s: the directory is unknown', (line, reason) => {
    expect(where(line, powerShell)).toEqual([['npm:x', unknown(reason)]]);
  });

  it('reads cd in cmd /c, where & runs the next command in the same shell', () => {
    expect(where('cmd /c "cd /d sub && npm i x"')).toEqual([['npm:x', entered('sub')]]);
    expect(where('cmd /c "cd sub & npm i x"')).toEqual([['npm:x', entered('sub')]]);
    expect(where('cmd /c "cd & npm i x"')).toEqual([['npm:x', undefined]]);
  });
});
