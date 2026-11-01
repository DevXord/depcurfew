// Findings of the third verification of 1.3.0 in the scanner (decision D-123): env -S read again as arguments, names
// of OLDPWD, PWD, DIRSTACK and CDPATH that the shell builds, the stack of pushd as bash keeps it, traps that change
// directory before later commands, aliases that end in a blank, PIPENV_PIPFILE, files run with . or source, and the
// directories a command leaves (cd -, popd), which must have been entered.
import { describe, expect, it } from 'vitest';
import { overrideDoubt, scanCommandLine, unknownDirectory, unreadableFix, type CommandDirectory, type KnownDirectory } from '../../src/check/command.ts';
import { policy } from './support.ts';

/** Each request as tool:spec with its directory (undefined: the directory the command starts in). */
const where = (line: string) => scanCommandLine(line).requests.map((request) => [`${request.tool}:${request.spec}`, request.directory]);
const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);
const steps = (...list: string[]): CommandDirectory => ({ steps: list });
/** Directories the shell changes to, which the hook checks exist (decision D-119). */
const entered = (...list: string[]): KnownDirectory => ({ steps: list, entered: list.map((_, index) => index) });
const unknown = (text: string) => ({ unknown: expect.stringContaining(text) as string });
const BUILT = 'may set a variable whose name the shell builds';

describe('env -S: GNU env reads the string again as arguments, options included (N1)', () => {
  it.each([
    ["env -S'-C pkgs/strict npm install x'", [['npm:x', steps('pkgs/strict')]]],
    ["env -S'-C pkgs/strict' npm install x", [['npm:x', steps('pkgs/strict')]]],
    ['env -S"--chdir=pkgs/strict npm install x"', [['npm:x', steps('pkgs/strict')]]],
    ["env -S '-Cpkgs/strict npm install x'", [['npm:x', steps('pkgs/strict')]]],
    ["env -iS'-C pkgs/strict' npm i x", [['npm:x', steps('pkgs/strict')]]],
    ["env --split-string='-C pkgs/strict npm i x'", [['npm:x', steps('pkgs/strict')]]],
    ["env --split '-C pkgs/strict' npm i x", [['npm:x', steps('pkgs/strict')]]],
    // A -S in the string is read again too.
    ["env -S'-i -S\"-C pkgs/strict\" npm i x'", [['npm:x', steps('pkgs/strict')]]],
    // env keeps one directory: the last -C counts, from where env starts.
    ['env -C a -C pkgs/strict npm i x', [['npm:x', steps('pkgs/strict')]]],
    ["env -C a -S'-C pkgs/strict' npm i x", [['npm:x', steps('pkgs/strict')]]],
    // \_ separates, # starts a comment to the end of the string, \c ends it; the words after the string still count.
    ["env -S'npm\\_install\\_x'", [['npm:x', undefined]]],
    ["env -S'npm i x # npm i y'", [['npm:x', undefined]]],
    ["env -S'npm i x \\c npm i y'", [['npm:x', undefined]]],
    ["env -S'npm i' x", [['npm:x', undefined]]],
    ['env -S"npm \\"i\\" \'x\'"', [['npm:x', undefined]]],
    // The variables env sets count for the command, also inside the string.
    ['env UV_PROJECT=sub uv add x', [['uv:pypi:x', steps('sub')]]],
    ["env -S'UV_PROJECT=sub uv add x'", [['uv:pypi:x', steps('sub')]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('runs nothing when env cannot split the string', () => {
    for (const line of ["env -S'npm i \\z'", "env -S'npm i \"x'", "env -S'npm i $X'", 'env -S']) expect(scanCommandLine(line)).toEqual({ requests: [], unreadable: undefined });
  });

  it('judges an override inside the string in the directory of env -C', () => {
    expect(scanCommandLine("env -S'-C pkgs/strict npm install x --min-release-age=30'").overrides).toEqual([
      expect.objectContaining({ written: '--min-release-age=30', delay: '30', directory: steps('pkgs/strict') }),
    ]);
    expect(scanCommandLine("env -S'npm_config_ignore_scripts=false npm ci'").overrides).toEqual([expect.objectContaining({ written: 'npm_config_ignore_scripts=false', weakens: 'scripts' })]);
  });

  it.each([['env $OPTS npm i x'], ['env "$OPTS" npm i x'], ['env -$O npm i x'], ['sudo $FLAGS npm i x']])(
    '%s: an option the shell expands may be -C, so the directory is unknown',
    (line) => {
      expect(where(line)).toEqual([['npm:x', unknown('the shell expands an option of')]]);
    },
  );

  it('asks about a string whose command env takes from its environment, or that the shell expands', () => {
    expect(scanCommandLine('env -S"$OPTS npm i x"').unreadable).toContain('"$OPTS" is expanded by the shell');
    expect(scanCommandLine('env -S"$O" npm i x').unreadable).toContain('"$O" is expanded by the shell');
    expect(scanCommandLine("env -S'${CMD} i x'").unreadable).toContain('is expanded by the shell');
    expect(scanCommandLine("env -S'npm i ${PKG}'").unreadable).toContain('"${PKG}" is expanded by the shell');
  });
});

describe('OLDPWD, PWD, DIRSTACK and CDPATH set by a name the shell builds (N2)', () => {
  it.each([
    ['cd a; X=OLD; declare "${X}PWD=/srv"; cd -; npm i x'],
    ['cd a; typeset "$N=/srv"; cd -; npm i x'],
    ['cd a; local "$N"; cd -; npm i x'],
    ['cd a; export $N; cd -; npm i x'],
    ['cd a; readonly "$N=/srv"; cd -; npm i x'],
    ['cd a; declare -i n; cd -; npm i x'],
    ['cd a; printf -v "${X}PWD" %s /srv; cd -; npm i x'],
    ['cd a; printf "$F" /srv; cd -; npm i x'],
    ['cd a; read -r "${X}D" <<< /srv; cd -; npm i x'],
    ['cd a; mapfile -t "$N" <<< /srv; cd -; npm i x'],
    ['cd a; readarray "$N" < list; cd -; npm i x'],
    ['cd a; unset "$N"; cd -; npm i x'],
    ['cd a; let "$N=1"; cd -; npm i x'],
    ['cd a; getopts a "$N" -a; cd -; npm i x'],
    ['cd a; wait -p "$N"; cd -; npm i x'],
    ['cd a; [[ $X -eq 1 ]]; cd -; npm i x'],
    ['cd a; arr[$X]=1; cd -; npm i x'],
    ['cd a; echo "${arr[$X]}"; cd -; npm i x'],
    ['cd a; echo "${s:$X}"; cd -; npm i x'],
    ['cd a; : "${!X:=/srv}"; cd -; npm i x'],
    ['cd a; echo $(( X = 1 + $Y )); cd -; npm i x'],
    ['cd a; eval "$N=/srv"; cd -; npm i x'],
    ['cd a; eval "x=1 $N"; cd -; npm i x'],
  ])('%s: cd - is unknown', (line) => {
    expect(where(line)).toEqual([['npm:x', unknown(BUILT)]]);
  });

  it.each([
    // The names count as the shell reads the words: after quotes, escapes and $'…'.
    ['cd a; eval "OLD""PWD=/srv"; cd -; npm i x'],
    ["cd a; eval OLD''PWD=/srv; cd -; npm i x"],
    ["cd a; eval $'OLD\\x50WD=/srv'; cd -; npm i x"],
    ['cd a; export OLD\\PWD=/srv; cd -; npm i x'],
    ['cd a; : "${OLDPWD:=/srv}"; cd -; npm i x'],
  ])('%s: cd - goes to the OLDPWD the command sets', (line) => {
    expect(where(line)).toEqual([['npm:x', unknown('OLDPWD')]]);
  });

  it('makes a relative cd, popd and pushd without a directory unknown too', () => {
    expect(where('declare "$N=1"; cd b; npm i x')).toEqual([['npm:x', unknown(BUILT)]]);
    expect(where('pushd a; declare "$N=1"; popd; npm i x')).toEqual([['npm:x', unknown(BUILT)]]);
    expect(where('pushd a; declare "$N=1"; pushd; npm i x')).toEqual([['npm:x', unknown(BUILT)]]);
    expect(where('declare "$N=1"; cd /srv && npm i x')).toEqual([['npm:x', entered('/srv')]]);
  });

  it.each([
    ['export PATH="$HOME/bin:$PATH"; cd b && npm i x'],
    ['local x="$1"; cd b && npm i x'],
    ['declare -a list=x; cd b && npm i x'],
    ['printf "%s\\n" "$X"; cd b && npm i x'],
    ['read -r line < file; cd b && npm i x'],
    ['echo $((1 + 2)) "$((i + 1))"; cd b && npm i x'],
    ['echo "${x:-$y}"; cd b && npm i x'],
  ])('%s: a name written out changes nothing', (line) => {
    expect(where(line)).toEqual([['npm:x', entered('b')]]);
  });
});

describe('the stack of pushd as bash keeps it (N3)', () => {
  it.each([
    // dirs -c empties the stack: popd then fails and the shell stays.
    ['pushd pkgs/strict; dirs -c; popd; npm i x', [['npm:x', entered('pkgs/strict')]]],
    ['dirs -c; pushd a; popd -n; popd; npm i x', [['npm:x', entered('a')]]],
    ['dirs -c; popd; npm i x', [['npm:x', undefined]]],
    ['dirs -c; pushd; npm i x', [['npm:x', undefined]]],
    ['pushd a; dirs -p -c; popd; npm i x', [['npm:x', entered('a')]]],
    // dirs -lc is a usage error; after -- nothing counts.
    ['pushd a; dirs -lc; popd; npm i x', [['npm:x', { steps: [], assumes: [entered('a')] }]]],
    ['pushd a; dirs -- -c; popd; npm i x', [['npm:x', { steps: [], assumes: [entered('a')] }]]],
    // pushd +N and -N turn the stack, with the current directory on top.
    ['dirs -c; pushd a; pushd b; pushd c; pushd +1; npm i x', [['npm:x', { ...entered('a', 'b'), assumes: [entered('a', 'b', 'c')] }]]],
    ['dirs -c; pushd a; pushd b; pushd c; pushd -0; npm i x', [['npm:x', { steps: [], assumes: [entered('a', 'b', 'c')] }]]],
    ['dirs -c; pushd a; pushd b; pushd +0; npm i x', [['npm:x', entered('a', 'b')]]],
    ['dirs -c; pushd a; pushd +5; npm i x', [['npm:x', entered('a')]]],
    ['pushd a; pushd -n +1; npm i x', [['npm:x', entered('a')]]],
    // popd +N and -N remove one directory; only the top one changes directory.
    ['dirs -c; pushd a; pushd b; popd +1; popd; npm i x', [['npm:x', { steps: [], assumes: [entered('a', 'b')] }]]],
    ['dirs -c; pushd a; pushd b; popd -0; popd; npm i x', [['npm:x', { ...entered('a'), assumes: [entered('a', 'b')] }]]],
    ['pushd a; pushd b; popd -n; npm i x', [['npm:x', entered('a', 'b')]]],
    // pushd -n puts the path on the stack as written; popd finds it from where the shell is then.
    ['pushd -n b; popd; npm i x', [['npm:x', entered('b')]]],
    ['pushd -n b; cd a; popd; npm i x', [['npm:x', entered('a', 'b')]]],
    // A usage error changes nothing; pushd -n alone does nothing; pushd -- swaps.
    ['pushd a; popd foo; npm i x', [['npm:x', entered('a')]]],
    ['pushd a; pushd -x; npm i x', [['npm:x', entered('a')]]],
    ['pushd a; pushd -n; npm i x', [['npm:x', entered('a')]]],
    ['pushd a; pushd --; npm i x', [['npm:x', { steps: [], assumes: [entered('a')] }]]],
    // pushd - is cd - that pushes the directory it leaves.
    ['cd a; pushd -; popd; npm i x', [['npm:x', entered('a')]]],
    ['cd a; pushd -; npm i x', [['npm:x', { steps: [], assumes: [entered('a')] }]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
  });

  it.each([
    ['pushd a; popd -n; popd; npm i x', 'goes back to a directory from before this command'],
    ['pushd a; pushd -1; npm i x', 'from before this command'],
    ['pushd a; pushd +5; npm i x', 'turns a stack that holds directories from before this command'],
    ['pushd a; popd -0; npm i x', 'from before this command'],
    ['pushd "$D"; popd; popd; npm i x', 'the shell expands the directory'],
    ['pushd a; dirs "$X"; popd; npm i x', 'which may empty the stack of pushd'],
    ['pushd a; popd "$N"; npm i x', 'the shell expands'],
    // A pushd that runs in a loop, a pipeline or one branch leaves the stack unknown too.
    ['pushd a; for i in 1; do pushd /srv; done; popd; npm i x', 'runs in a loop'],
    ['pushd a; if x; then pushd /srv; fi; popd; npm i x', 'runs only in one branch'],
    ['cd a; if x; then cd /srv; fi; cd -; npm i x', 'runs only in one branch'],
    ['cd a; cd "$D"; cd -; npm i x', 'the shell expands the directory'],
  ])('%s: the directory is unknown', (line, reason) => {
    expect(where(line)).toEqual([['npm:x', unknown(reason)]]);
  });

  it('follows at most 64 directories on the stack', () => {
    expect(where(`${'pushd /srv; '.repeat(70)}${'popd; '.repeat(64)}npm i x`)).toEqual([['npm:x', unknown('depcurfew follows at most 64 directories on the stack of pushd')]]);
    expect(where(`${'pushd /srv; '.repeat(70)}popd; npm i x`)).toEqual([['npm:x', expect.objectContaining({ steps: ['/srv'] })]]);
  });
});

describe('the directories a command leaves must have been entered (N3)', () => {
  it.each([
    // A cd that fails leaves OLDPWD and the stack as they were, so the hook checks the directories cd - and popd leave.
    ['cd nope; cd -; npm i x', [['npm:x', { steps: [], assumes: [entered('nope')] }]]],
    ['pushd nope; popd; npm i x', [['npm:x', { steps: [], assumes: [entered('nope')] }]]],
    ['pushd a; cd /srv; popd; npm i x', [['npm:x', { steps: [], assumes: [entered('a'), entered('/srv')] }]]],
    ['cd a; cd /srv; cd -; npm i x', [['npm:x', { ...entered('a'), assumes: [entered('/srv')] }]]],
    // A directory that mkdir creates on the line need not be checked.
    ['mkdir -p app && cd app && cd - && npm i x', [['npm:x', undefined]]],
  ])('%s', (line, expected) => {
    expect(where(line)).toEqual(expected);
  });

  it('checks at most 16 of them', () => {
    expect(where(`${Array.from({ length: 17 }, (_, index) => `cd /d${index}; `).join('')}cd -; npm i x`)).toEqual([['npm:x', unknown('depcurfew checks at most 16 of them')]]);
  });
});

describe('a trap that changes directory before later commands (N4)', () => {
  it.each([
    ["trap 'cd pkgs/strict' DEBUG; npm i x"],
    ["trap 'pushd pkgs/strict' DEBUG; npm i x"],
    ["trap 'cd pkgs/strict' DEBUG\nnpm i x"],
    ["trap -- 'cd pkgs/strict' debug; npm i x"],
    ["trap 'cd pkgs/strict' ERR; false; npm i x"],
    ["trap 'cd pkgs/strict' RETURN; f; npm i x"],
    ["trap 'cd pkgs/strict' USR1 EXIT; kill -USR1 $$; npm i x"],
    ["trap 'cd pkgs/strict' \"$SIGNAL\"; npm i x"],
    ["trap 'set -P' DEBUG; npm i x"],
    ["trap 'f' DEBUG; f() { cd pkgs/strict; }; npm i x"],
    // A later cd does not help: the trap runs before every command.
    ["trap 'cd pkgs/strict' DEBUG; cd /srv; npm i x"],
  ])('%s: the directory of every later command is unknown', (line) => {
    expect(where(line)).toEqual([['npm:x', expect.objectContaining({ unknown: expect.stringMatching(/runs before or between later commands|runs in a function/u) as string })]]);
  });

  it('asks about a trap whose action it cannot read, and leaves the directory unknown', () => {
    const scan = scanCommandLine('trap "$ACTION" DEBUG; npm i x');
    expect(scan.unreadable).toContain('is expanded by the shell');
    expect(scan.requests[0]?.directory).toEqual(unknown('may change directory with an action depcurfew cannot read'));
  });

  it.each([["trap 'cd pkgs/strict' EXIT; npm i x"], ["trap 'cd pkgs/strict' 0; npm i x"], ["(trap 'cd pkgs/strict' DEBUG); npm i x"], ["trap 'echo hi' DEBUG; npm i x"], ['trap - DEBUG; npm i x']])(
    '%s: the directory stays',
    (line) => {
      expect(where(line)).toEqual([['npm:x', undefined]]);
    },
  );
});

describe('an alias whose value ends in a blank expands the next word too (N5)', () => {
  it.each([
    ["shopt -s expand_aliases\nalias n='npm '\nalias x='install fresh-pkg@1.1.0'\nn x", ['npm:fresh-pkg@1.1.0']],
    ["alias s='sudo ' n='npm '; alias i='install x'; s n i", ['npm:x']],
    ["alias n='npm ' i='install '; alias p='lodash'; n i p", ['npm:lodash']],
    ["alias n='cd a && npm '; alias x='install y'; n x", ['npm:y']],
    // Without a blank at the end the next word stays as it is.
    ["alias n='npm'; alias x='install y'; n x", []],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
  });

  it('expands the same alias again as the next word, as bash does, and stops at the end of the words', () => {
    // npm install install: bash expands the second x too.
    expect(specs("alias n='npm '; alias x='install '; n x x")).toEqual(['npm:install']);
    expect(scanCommandLine(`alias n='n '; ${'n '.repeat(1000)}`)).toEqual({ requests: [], unreadable: undefined });
  });
});

describe('PIPENV_PIPFILE names the Pipfile, whose directory is the project (N7)', () => {
  it('checks the install in the directory of the Pipfile', () => {
    expect(where('PIPENV_PIPFILE=../pipenv-first/Pipfile pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', steps('../pipenv-first')]]);
    expect(where('PIPENV_PIPFILE=/srv/app/Pipfile pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', steps('/srv/app')]]);
    expect(where('PIPENV_PIPFILE=Pipfile pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', steps('.')]]);
    expect(where('env PIPENV_PIPFILE=sub/Pipfile pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', steps('sub')]]);
  });

  it('cannot tell the directory for a file of another name, or a variable set apart from the command', () => {
    expect(where('PIPENV_PIPFILE=deploy/Pipfile.prod pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', unknown('a file depcurfew does not read')]]);
    expect(where('export PIPENV_PIPFILE=sub/Pipfile; pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', unknown('apart from the command')]]);
    expect(where('PIPENV_PIPFILE="$F" pipenv install mid-py')).toEqual([['pipenv:pypi:mid-py', unknown('the shell expands PIPENV_PIPFILE')]]);
  });
});

describe('a file run with . or source, and a function that changes directory (N8)', () => {
  it.each([
    ['echo "cd pkgs/strict" > x.sh; . ./x.sh; npm i x', 'runs a file in this shell'],
    ['source x.sh; cd /srv; npm i x', 'runs a file in this shell'],
    ['. "$F"; npm i x', 'runs a file in this shell'],
    ['source <(echo cd a); npm i x', 'runs a file in this shell'],
    ['f() { cd pkgs/strict; }; cd /srv; npm i x', 'runs in a function'],
  ])('%s: the directory of every later command is unknown', (line, reason) => {
    expect(where(line)).toEqual([['npm:x', unknown(reason)]]);
    const directory = scanCommandLine(line).requests[0]?.directory;
    if (directory !== undefined && 'unknown' in directory && reason.includes('file')) {
      expect(unreadableFix(unknownDirectory('npm i x', directory.unknown))).toBe(
        'Run the install as a command of its own, without . or source of a file or a trap that changes directory before it, so depcurfew checks it with the policy of the directory it runs in',
      );
    }
  });

  it('follows the commands that source reads from a here-string', () => {
    expect(where("source /dev/stdin <<< 'cd pkgs/strict'; npm i x")).toEqual([['npm:x', entered('pkgs/strict')]]);
  });

  it('stays out of the way of a command that installs nothing', () => {
    expect(scanCommandLine('source .venv/bin/activate && pytest')).toEqual({ requests: [], unreadable: undefined });
    expect(where('(. ./env.sh); npm i x')).toEqual([['npm:x', undefined]]);
    expect(where('. ./env.sh & npm i x')).toEqual([['npm:x', undefined]]);
  });
});

describe('the activation script of a Python virtual environment (follow-up to N8)', () => {
  const venv = (...list: string[]): KnownDirectory => ({ steps: list, venv: true });

  it.each([
    ['source .venv/bin/activate && pip install requests', { steps: [], assumes: [venv('.venv')] }],
    ['. venv/bin/activate && pip install requests', { steps: [], assumes: [venv('venv')] }],
    ['source env/bin/activate.fish; pip install requests', { steps: [], assumes: [venv('env')] }],
    ['source env/bin/activate.csh; pip install requests', { steps: [], assumes: [venv('env')] }],
    ['source bin/activate && pip install requests', { steps: [], assumes: [venv('.')] }],
    ['source /opt/venv/bin/activate && pip install requests', { steps: [], assumes: [venv('/opt/venv')] }],
    ['cd backend && source .venv/bin/activate && pip install requests', { steps: ['backend'], entered: [0], assumes: [{ steps: ['backend', '.venv'], entered: [0], venv: true }] }],
    ['source .venv/bin/activate 2>/dev/null && echo ok >/dev/null && pip install requests', { steps: [], assumes: [venv('.venv')] }],
    ["eval 'source .venv/bin/activate; pip install requests'", { steps: [], assumes: [venv('.venv')] }],
  ])('%s: the hook checks the virtual environment', (line, directory) => {
    expect(where(line)).toEqual([['pip:pypi:requests', directory]]);
  });

  it('reads the Windows layout in PowerShell, with \\ and in any case', () => {
    const powerShell = (line: string) => scanCommandLine(line, { shell: 'powershell' }).requests.map((request) => request.directory);
    expect(powerShell('. .venv\\Scripts\\Activate.ps1; pip install requests')).toEqual([{ steps: [], assumes: [venv('.venv')] }]);
    expect(powerShell('. .venv/scripts/activate.ps1; pip install requests')).toEqual([{ steps: [], assumes: [venv('.venv')] }]);
    expect(powerShell('. .venv/bin/Activate.ps1; pip install requests')).toEqual([{ steps: [], assumes: [venv('.venv')] }]);
    // The script run with & changes nothing that depcurfew follows, as before.
    expect(powerShell('& .venv/Scripts/Activate.ps1; pip install requests')).toEqual([undefined]);
  });

  it.each([
    ["echo 'cd pkgs/strict' > .venv/bin/activate; source .venv/bin/activate && pip install requests"],
    ['cat > .venv/bin/activate <<EOF\ncd pkgs/strict\nEOF\nsource .venv/bin/activate && pip install requests'],
    ['echo cd pkgs/strict | tee .venv/bin/activate; source .venv/bin/activate && pip install requests'],
    ['cp evil.sh .venv/bin/activate && source .venv/bin/activate && pip install requests'],
    ['mv evil.sh .venv/bin/activate && source .venv/bin/activate && pip install requests'],
    ['ln -sf ../../evil.sh .venv/bin/activate && source .venv/bin/activate && pip install requests'],
    ['python -m venv .venv && source .venv/bin/activate && pip install requests'],
    ['echo "$(cp evil.sh .venv/bin/activate)"; source .venv/bin/activate && pip install requests'],
    ["alias cd='cp evil.sh .venv/bin/activate'; cd .; source .venv/bin/activate && pip install requests"],
    ["echo x > f; eval 'source .venv/bin/activate; pip install requests'"],
    // <> opens the file for writing too, and a redirection after ( … ) belongs to the subshell.
    ["echo 'cd pkgs/strict' 1<>.venv/bin/activate; source .venv/bin/activate; pip install requests"],
    ["printf 'cd pkgs/strict' 1<> .venv/bin/activate; source .venv/bin/activate; pip install requests"],
    ["cat <<< 'cd pkgs/strict' 1<>.venv/bin/activate; source .venv/bin/activate; pip install requests"],
    ["echo 'cd pkgs/strict' 0<>.venv/bin/activate >&0; source .venv/bin/activate; pip install requests"],
    ["(echo 'cd pkgs/strict') >> .venv/bin/activate; source .venv/bin/activate; pip install requests"],
    ["(echo 'cd pkgs/strict'; true) > .venv/bin/activate && source .venv/bin/activate && pip install requests"],
    ['> .venv/bin/activate; source .venv/bin/activate; pip install requests'],
    ["eval \"echo 'cd pkgs/strict' 1<> .venv/bin/activate; source .venv/bin/activate; pip install requests\""],
  ])('%s: a command before it may write the script, so the directory is unknown', (line) => {
    expect(where(line)).toEqual([['pip:pypi:requests', unknown('after a command on the line that may write it')]]);
  });

  it.each([
    ['source .venv/bin/activate.sh && pip install requests'],
    ['source .venv/lib/activate && pip install requests'],
    ['source activate && pip install requests'],
    ['source ~/.venvs/app/bin/activate && pip install requests'],
    ['source "$VENV/bin/activate" && pip install requests'],
  ])('%s: any other file still makes the directory unknown', (line) => {
    expect(where(line)).toEqual([['pip:pypi:requests', unknown('runs a file in this shell')]]);
  });
});

describe('the message of an override names the policy file that sets the delay (N10)', () => {
  it('names the file the hook gives', () => {
    const overrides = scanCommandLine('cd pkgs/strict && npm install old-pkg@1.0.0 --min-release-age=30').overrides;
    const strict = policy({ cooldown: { minimum: '90d' } });
    const root = policy({ cooldown: { minimum: '1d' } });
    expect(overrideDoubt(overrides, [root, strict], ['depcurfew.json', 'pkgs/strict/depcurfew.json'])).toContain('shorter than the 90 days in pkgs/strict/depcurfew.json');
    expect(overrideDoubt(overrides, [strict])).toContain('shorter than the 90 days in depcurfew.json');
    const scripts = policy({ installScripts: { default: 'deny' } });
    expect(overrideDoubt(scanCommandLine('npm ci --ignore-scripts=false').overrides, [root, scripts], ['depcurfew.json', 'app/depcurfew.json'])).toContain('that app/depcurfew.json restricts');
  });
});
