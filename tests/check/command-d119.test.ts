// Findings of the last verification of 1.3.0 (decision D-119) in the scanner: changes of directory that may fail or
// that bash resolves another way (a cd that the hook must check, cd -P and set -P, OLDPWD and PWD set in the command),
// aliases that expand themselves, $'…' and $"…" read as bash reads them, a command built at run time inside a command
// line, nopt's --no- with an abbreviation, env -C, find -execdir, traps that run later, and PowerShell paths with \.
import { describe, expect, it } from 'vitest';
import { overrideDoubt, scanCommandLine, unreadableFix, type CommandDirectory, type KnownDirectory, type ScanOptions } from '../../src/check/command.ts';
import { policy } from './support.ts';

const specs = (line: string, options?: ScanOptions) => scanCommandLine(line, options).requests.map((request) => `${request.tool}:${request.spec}`);
/** Each request as tool:spec with its directory (undefined: the directory the command starts in). */
const where = (line: string, options?: ScanOptions) => scanCommandLine(line, options).requests.map((request) => [`${request.tool}:${request.spec}`, request.directory]);
/** Directories the shell changes to, each of which the hook checks exists. */
const entered = (...list: string[]): KnownDirectory => ({ steps: list, entered: list.map((_, index) => index) });
const unknown = (text: string) => ({ unknown: expect.stringContaining(text) as string });
const SCRIPTS = policy({ installScripts: { default: 'deny' } });

describe('changes of directory the hook must check (H1)', () => {
  it.each([
    ['cd a && npm i x', [['npm:x', entered('a')]]],
    ['cd a && cd b && npm i x', [['npm:x', entered('a', 'b')]]],
    ['pushd a && npm i x', [['npm:x', entered('a')]]],
    ['cd /srv/app; npm i x', [['npm:x', entered('/srv/app')]]],
    ['cd a && npm --prefix b i x', [['npm:x', { steps: ['a', 'b'], localPrefix: true, entered: [0] }]]],
    // A directory that a mkdir earlier in the command creates need not exist yet.
    ['mkdir -p app && cd app && npm i x', [['npm:x', { steps: ['app'] }]]],
    ['mkdir -p a/b && cd a && cd b && npm i x', [['npm:x', { steps: ['a', 'b'] }]]],
    ['mkdir a/b && cd a/b && npm i x', [['npm:x', { steps: ['a/b'] }]]],
    ['cd a && mkdir b && cd b && npm i x', [['npm:x', { steps: ['a', 'b'], entered: [0] }]]],
    ['mkdir app; cd other && npm i x', [['npm:x', entered('other')]]],
    // cd -P and set -P resolve the path physically, through symlinks; the last of -L and -P counts.
    ['cd -P l/.. && npm i x', [['npm:x', { steps: ['l/..'], entered: [0], physical: [0] }]]],
    ['cd -LP l/.. && npm i x', [['npm:x', { steps: ['l/..'], entered: [0], physical: [0] }]]],
    ['cd -PL l/.. && npm i x', [['npm:x', entered('l/..')]]],
    ['set -P; cd l/.. && npm i x', [['npm:x', { steps: ['l/..'], entered: [0], physical: [0] }]]],
    ['set -eP; cd a; cd b; npm i x', [['npm:x', { steps: ['a', 'b'], entered: [0, 1], physical: [0, 1] }]]],
    ['set -o physical; cd a && npm i x', [['npm:x', { steps: ['a'], entered: [0], physical: [0] }]]],
    ['set -P; set +P; cd a && npm i x', [['npm:x', entered('a')]]],
    ['(set -P); cd a && npm i x', [['npm:x', entered('a')]]],
    ['set -euo pipefail; cd a && npm i x', [['npm:x', entered('a')]]],
    // Reading PWD or OLDPWD changes nothing.
    ['echo "$PWD $OLDPWD"; cd a && cd - && npm i x', [['npm:x', { steps: [], assumes: [entered('a')] }]]],
    ['PWD=/srv cd /abs && npm i x', [['npm:x', entered('/abs')]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    ['cd a; OLDPWD=$PWD; cd -; npm i x', 'OLDPWD'],
    ['cd a; unset OLDPWD; cd -; npm i x', 'OLDPWD'],
    ['export OLDPWD=/srv; cd - && npm i x', 'OLDPWD'],
    ['PWD=/srv; cd a && npm i x', 'PWD'],
    ['cd a; PWD=/; cd ..; npm i x', 'PWD'],
    ['DIRSTACK[1]=/srv; pushd a; popd; npm i x', 'DIRSTACK'],
    ['if true; then set -P; fi; cd a && npm i x', 'runs only in one branch'],
  ])('%s: the directory is unknown', (line, reason) => {
    expect(where(line)).toEqual([['npm:x', unknown(reason)]]);
  });
});

describe('aliases that expand themselves (H2)', () => {
  it('expands an alias at most once per expansion, as bash does', () => {
    expect(specs(`alias a='npm i x; a; a'; a`)).toEqual(['npm:x', 'npm:x']);
    expect(specs(`alias a='b' b='a; npm i y'\na`)).toEqual(['npm:y', 'npm:y']);
    expect(scanCommandLine(`alias a='${'a;'.repeat(30)}'; a`)).toEqual({ requests: [], unreadable: undefined });
  });

  it('asks when the command expands to more than it reads', () => {
    const chain = `alias d='${'true;'.repeat(30)}'; alias c='${'d;'.repeat(30)}'; alias b='${'c;'.repeat(30)}'; alias a='${'b;'.repeat(30)}'; a`;
    const scan = scanCommandLine(chain);
    expect(scan.unreadable).toContain('depcurfew stops reading after');
    expect(unreadableFix(scan.unreadable ?? '')).toBe('Run the commands one by one, without aliases or eval that repeat them, so depcurfew can read each of them');
  });
});

describe('$\'…\' and $"…" are read as bash reads them (H4)', () => {
  it.each([
    ["trap $'npm install fresh-pkg@1.1.0' EXIT", ['npm:fresh-pkg@1.1.0']],
    ["eval $'npm install x'", ['npm:x']],
    ["bash -c $'npm install x'", ['npm:x']],
    ["sh -c $'cd a\\nnpm i x'", ['npm:x']],
    ["$'np\\x6d' install x", ['npm:x']],
    ["npm $'\\x69nstall' lodash", ['npm:lodash']],
    ["$'\\156\\160\\155' i x", ['npm:x']],
    ["npm i $'lod\\u0061sh' $'\\U00000078'", ['npm:lodash', 'npm:x']],
    ["eval $'npm i x;npm i \\'y\\''", ['npm:x', 'npm:y']],
    // A NUL ends the text of $'…'; the rest of the word stays.
    ["npm i $'a\\x00bc'd", ['npm:ad']],
    ["bash <<< $'npm i x'", ['npm:x']],
    ['$"npm" i x', ['npm:x']],
    ['eval $"npm i x"', ['npm:x']],
    // In double quotes, $'…' is not decoded.
    [`echo "$'\\x41'"`, []],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    // Bytes that are not ASCII, and $'…' that is not closed, cannot be decoded.
    ["npm i $'\\xe9'", 'is expanded by the shell'],
    ["eval $'\\xe9; npm i x'", 'is expanded by the shell'],
    ["eval $'npm i x", 'is expanded by the shell'],
  ])('asks about %s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });

  it('reads $"…" as a dynamic word when the command sets a translation domain', () => {
    expect(scanCommandLine('TEXTDOMAIN=x TEXTDOMAINDIR=. eval $"echo hi"').unreadable).toContain('is expanded by the shell');
  });
});

describe('a command built at run time inside a command line asks (H4)', () => {
  it.each([
    ["eval 'x$A'", 'the command "x$A" is expanded by the shell'],
    ["bash -c '${A}x'", 'the command "${A}x" is expanded by the shell'],
    ['eval "n$(echo pm) $(echo install) x"', 'is expanded by the shell'],
    ["sh -c '/usr/bin/np[m] $(echo i) x'", 'is expanded by the shell'],
    ["trap '$A' EXIT", 'is expanded by the shell'],
    // Brace expansion turns one word into several, also outside a command line.
    ['{npm,install,x}', 'the command "{npm,install,x}" is expanded by the shell'],
    ['. "$X" i x', 'the file "$X" is expanded by the shell and may be a package manager'],
  ])('%s', (line, reason) => {
    const scan = scanCommandLine(line);
    expect(scan.unreadable).toContain(reason);
    expect(scan.requests).toEqual([]);
  });

  it.each([
    ["bash -c 'echo $HOME'"],
    ["eval 'echo \"$x\"'"],
    ["sh -c '\"$HOME/bin/tool\" --flag'"],
    ["bash -c 'ls *.txt'"],
    ['echo {a,b}'],
    ['source "$F"'],
    ['$EDITOR notes.txt'],
  ])('stays silent about %s', (line) => {
    expect(scanCommandLine(line)).toEqual({ requests: [], unreadable: undefined });
  });
});

describe("nopt's --no- with an abbreviated name (M1)", () => {
  it.each([
    ['npm ci --no-ignore-script', '--no-ignore-script'],
    ['npm ci --no-ign', '--no-ign'],
    ['npm ci -no-ign', '-no-ign'],
    ['npm ci --NO-ignore-scripts', '--NO-ignore-scripts'],
    ['npm install --no-ignore-scrip x', '--no-ignore-scrip'],
    ['npm ci --ign=false', '--ign=false'],
    ['npm ci --no-no-ignore-scripts false', '--no-no-ignore-scripts false'],
    ['pnpm install --no-ign', '--no-ign'],
    ['pnpm add --no-ignore-scr x', '--no-ignore-scr'],
    ['pnpm add --ignore-scr=false x', '--ignore-scr=false'],
  ])('%s turns install scripts on', (line, written) => {
    expect(scanCommandLine(line).overrides).toEqual([expect.objectContaining({ written, weakens: 'scripts' })]);
    expect(overrideDoubt(scanCommandLine(line).overrides, [SCRIPTS])).toContain('lets dependency install scripts run that depcurfew.json restricts');
  });

  it.each([['npm ci --no-no-ignore-scripts'], ['npm ci --no-ignore-scripts=false'], ['npm ci --no-dangerously-allow-all-scr'], ['npm ci --ignore-scr']])(
    '%s keeps them off',
    (line) => {
      expect(scanCommandLine(line).overrides).toBeUndefined();
    },
  );
});

describe('commands that run an install in another directory (M2)', () => {
  it.each([
    ['env -C pkgs/strict npm install x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ['env --chdir=pkgs/strict npm i x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ['env --chdir pkgs/strict npm i x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ['env --ch=pkgs/strict npm i x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ['env -Cpkgs/strict npm i x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ['env -iC pkgs/strict A=1 npm i x', [['npm:x', { steps: ['pkgs/strict'] }]]],
    ["env -C sub -S 'npm i x'", [['npm:x', { steps: ['sub'] }]]],
    ['cd a && env -C b npm i x', [['npm:x', { steps: ['a', 'b'], entered: [0] }]]],
    ['sudo -D sub npm i x', [['npm:x', { steps: ['sub'] }]]],
    ['sudo --chdir=sub npm i x', [['npm:x', { steps: ['sub'] }]]],
    // env cannot run cd, a builtin of the shell; find -exec runs in the directory find was started in.
    ['env -C sub cd a; npm i y', [['npm:y', undefined]]],
    ['find . -name package.json -exec npm i x \\;', [['npm:x', undefined]]],
    ["cd a; trap 'npm i x' EXIT", [['npm:x', entered('a')]]],
    ["trap 'npm i x' EXIT; cd a &", [['npm:x', undefined]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    ['env -C "$D" npm i x', 'the shell expands'],
    ['find . -name package.json -execdir npm install x \\;', 'find -execdir runs "npm install x" in the directory of each file it finds'],
    ['find . -okdir npm i x \\;', 'find -okdir runs'],
    ["trap 'npm i x' EXIT; cd a", 'runs from a trap'],
    ["trap 'npm i x' DEBUG; eval 'cd a'", 'runs from a trap'],
  ])('%s: the directory is unknown', (line, reason) => {
    expect(where(line)).toEqual([['npm:x', unknown(reason)]]);
  });
});

describe('PowerShell and cmd paths with backslashes (V5)', () => {
  const powerShell: ScanOptions = { shell: 'powershell' };

  it.each([
    ['cd pkgs\\strict; npm install x', [['npm:x', entered('pkgs/strict')]]],
    ['Set-Location pkgs\\strict; npm i x', [['npm:x', entered('pkgs/strict')]]],
    ["Set-Location -LiteralPath 'pkgs\\strict'; npm i x", [['npm:x', entered('pkgs/strict')]]],
    ['Push-Location ..\\other; npm i x', [['npm:x', entered('../other')]]],
    ['cd\\; npm i x', [['npm:x', entered('/')]]],
  ])('%s', (line, expected) => {
    expect(where(line, powerShell)).toEqual(expected);
  });

  it('reads cmd paths with backslashes', () => {
    expect(where('cmd /c "cd /d sub\\dir && npm i x"')).toEqual([['npm:x', entered('sub/dir')]]);
  });

  it('leaves the path of a package manager option as the package manager reads it', () => {
    expect(where('npm --prefix sub\\dir i x', powerShell)).toEqual([['npm:x', { steps: ['sub\\dir'], localPrefix: true }]]);
  });
});
