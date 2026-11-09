// Decision D-172 in the scanner. npm link with package specs installs each one that is not in the global space first
// (lib/commands/link.js at v12.2.1 and 11.21.1), so its specs are checked like those of an install, as linked ones. A
// here-document ends where bash 5.2 ends it: with an unquoted delimiter a line is joined with the next one at an
// unescaped backslash before its newline, and only then are the tabs of <<- stripped and the line compared, and the
// delimiter word loses a backslash-newline and its quotes as bash removes them. A command name given another program
// with hash -p, BASH_CMDS or BASH_ALIASES is followed like an alias, and one given in a way depcurfew does not read
// makes the line unreadable. pipx inject, pipx runpip, pipx install-all and pipx manifest sync (pipx 1.18.12) are read.
// Every expected result of a shell line was checked on GNU bash 5.2.21 with a fake npm that prints its arguments.
import { describe, expect, it } from 'vitest';
import { cpuNow } from '../support/cpu-time.ts';
import { scanCommandLine, unreadableFix } from '../../src/check/command.ts';

const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);
const unreadable = (line: string) => scanCommandLine(line).unreadable;

describe('npm link with package specs', () => {
  it.each([
    ['npm link lodash', ['npm:lodash']],
    ['npm ln lodash', ['npm:lodash']],
    // npm resolves lin to link (the only command or alias that starts with it), and linK as kebab-case is not link.
    ['npm lin lodash', ['npm:lodash']],
    ['npm link lodash@4.17.21 @scope/pkg', ['npm:lodash@4.17.21', 'npm:@scope/pkg']],
    ['npm link --save-dev lodash', ['npm:lodash']],
    ['npm link -w web lodash', ['npm:lodash']],
    ['npm --loglevel silent link lodash', ['npm:lodash']],
    // A directory is a spec as for npm install: check classifies it and applies sources.directory.
    ['npm link ../lib', ['npm:../lib']],
    ['npm link github:evil/repo', ['npm:github:evil/repo']],
    ['cd app && npm link lodash', ['npm:lodash']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(unreadable(line)).toBeUndefined();
    for (const request of scanCommandLine(line).requests) expect(request.linked, line).toBe(true);
  });

  it('marks only the specs of npm link as linked', () => {
    const requests = scanCommandLine('npm i lodash && npm link lodash').requests;
    expect(requests.map((request) => [request.spec, request.linked])).toEqual([
      ['lodash', undefined],
      ['lodash', true],
    ]);
  });

  it.each([
    // Without specs npm link links the current package into the global space.
    'npm link',
    'npm link --dry-run',
    // npm unlink is npm uninstall.
    'npm unlink lodash',
    // npm link is npm's alone (linkCommands): the link commands of pnpm, Yarn and Bun are read as before.
    'pnpm link lodash',
    'yarn link lodash',
    'bun link lodash',
  ])('%s installs nothing to check', (line) => {
    expect(specs(line)).toEqual([]);
    expect(unreadable(line)).toBeUndefined();
  });

  it('asks about a spec the shell expands, as for npm install', () => {
    expect(unreadable('npm link "$PKG"')).toContain('is expanded by the shell');
  });
});

describe('here-documents end where bash ends them', () => {
  it.each([
    // An unquoted delimiter split by a backslash-newline ends the here-document; bash runs the next line.
    ['cat <<EOF\nx\nEO\\\nF\nnpm i x', ['npm:x']],
    ['cat <<EOF\nx\nE\\\nO\\\nF\nnpm i x', ['npm:x']],
    ['cat <<EOF\nx\n\\\nEOF\nnpm i x', ['npm:x']],
    ['cat <<A <<B\na\nA\\\n\nb\nB\nnpm i x', ['npm:x']],
    ['cat <<A <<B\na\n\\\nA\nb\nB\nnpm i x', ['npm:x']],
    // An escaped backslash is no continuation; three backslashes are one escaped and one continuation.
    ['cat <<EOF\nx\nEO\\\\\nF\nEOF\nnpm i y', ['npm:y']],
    ['cat <<EOF\nx\nEO\\\\\\\nF\nEOF\nnpm i y', ['npm:y']],
    // The joined line is the body line: a delimiter on the line after a continuation is part of it.
    ['cat <<EOF\nx\nEOF\\\nnpm i x\nEOF', []],
    ['cat <<EOF\na\\\nEOF\nnpm i x\nEOF\nnpm i y', ['npm:y']],
    // <<- strips the tabs of the joined line: those before the continuation, not those after it.
    ['cat <<-EOF\n\tx\n\tE\\\nOF\nnpm i x', ['npm:x']],
    ['cat <<-EOF\n\tx\n\tEO\\\n\tF\nnpm i x\nEOF', []],
    ['cat <<-EOF\n\tx\nEO\\\n\tF\nnpm i x\nEOF', []],
    // A quoted delimiter keeps every line as it is.
    ["cat <<'EOF'\nx\nEO\\\nF\nnpm i x\nEOF", []],
    ["cat <<'EOF'\nEOF\\\nnpm i x", []],
    ['cat <<"EOF"\nx\nEO\\\nF\nnpm i x\nEOF', []],
    // A backslash before a carriage return or before the delimiter is no continuation.
    ['cat <<EOF\nx\nEO\\\r\nF\nEOF\nnpm i x', ['npm:x']],
    ['cat <<EOF\nx\n\\EOF\nnpm i x\nEOF', []],
    ['cat <<EOF\nx\n EOF\nnpm i x', []],
    // The delimiter word: a backslash-newline in it is removed, also inside double quotes, and quotes are removed as
    // bash removes them (in double quotes a backslash escapes only \ " $ ` and a newline).
    ['cat <<EO\\\nF\nx\nEOF\nnpm i x', ['npm:x']],
    ['cat <<"EO\\\nF"\nx\nEOF\nnpm i x', ['npm:x']],
    ["cat <<'EO\\\nF'\nx\nEO\\\nF\nnpm i x", []],
    ['cat <<"a\\"b"\nx\na"b\nnpm i x', ['npm:x']],
    ['cat <<"a\\$b"\nx\na$b\nnpm i x', ['npm:x']],
    ['cat <<"a\\b"\nx\na\\b\nnpm i x', ['npm:x']],
    // Inside $(...), and the body of a shell's here-document joined as bash reads it.
    ['echo $(cat <<EOF\nx\nEO\\\nF\n); npm i x', ['npm:x']],
    ['bash <<EOF\nnp\\\nm i x\nEOF', ['npm:x']],
    ["bash <<'EOF'\nnp\\\nm i x\nEOF", ['npm:x']],
  ])('%j', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(unreadable(line)).toBeUndefined();
  });
});

describe('in linear time', () => {
  it('reads a here-document of a million characters of continuations and of backslashes', () => {
    for (const body of ['x\\\n'.repeat(330_000), '\\'.repeat(1_000_000), 'a\\b\n'.repeat(250_000)]) {
      const line = `cat <<EOF\n${body}\nEOF\nnpm i x`;
      const start = cpuNow();
      expect(specs(line)).toEqual(['npm:x']);
      expect(cpuNow() - start).toBeLessThan(2000);
    }
  });

  it('reads a long run of assignments to array elements', () => {
    for (const line of [`${'a[0]=1 '.repeat(100_000)}npm i x`, `${'BASH_CMDS[x]=/bin/x '.repeat(50_000)}`.trim()]) {
      const start = cpuNow();
      scanCommandLine(line);
      expect(cpuNow() - start).toBeLessThan(2000);
    }
    expect(specs(`${'a[0]=1 '.repeat(1000)}npm i x`)).toEqual(['npm:x']);
  });
});

describe('command names given another program in the same command', () => {
  it.each([
    ['hash -p /usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm foo\nfoo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm foo bar; bar i lodash', ['npm:lodash']],
    ['hash -p/usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['hash -dp /usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['hash -r -p /usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm -r foo; foo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm -- foo; foo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm - foo; foo i lodash', ['npm:lodash']],
    ['builtin hash -p /usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['command hash -p /usr/bin/npm foo; foo i lodash', ['npm:lodash']],
    ['eval "hash -p /usr/bin/npm foo"; foo i lodash', ['npm:lodash']],
    ['hash -p /usr/bin/npm foo; (foo i lodash)', ['npm:lodash']],
    ['hash -p /usr/bin/npm foo; \\foo i lodash', ['npm:lodash']],
    // hash takes precedence over a program of PATH, and the path may hold blanks.
    ['hash -p /usr/bin/npm ls; ls i lodash', ['npm:lodash']],
    ["hash -p '/opt/my tools/npm' foo; foo i lodash", ['npm:lodash']],
    ['hash -p /usr/bin/pip foo; foo install requests', ['pip:pypi:requests']],
    ['hash -p /usr/local/bin/composer c; c require monolog/monolog', ['composer:composer:monolog/monolog']],
    // zsh: hash name=value puts the name in the command hash table.
    ['hash foo=/usr/bin/npm; foo i lodash', ['npm:lodash']],
    // bash runs the command after an assignment to an array element, which it refuses.
    ['hash -p /usr/bin/npm foo; a[0]=1 foo i lodash', ['npm:lodash']],
    // BASH_CMDS is the hash table: a key set alone is hash -p.
    ['BASH_CMDS[foo]=/usr/bin/npm; foo i lodash', ['npm:lodash']],
    ['BASH_CMDS["foo"]=/usr/bin/npm; foo i lodash', ['npm:lodash']],
    ['BASH_CMDS[foo]=/usr/bin/npm BASH_CMDS[bar]=/usr/bin/npm; bar i lodash', ['npm:lodash']],
    // BASH_ALIASES is the alias table: a key set alone is alias.
    ['shopt -s expand_aliases\nBASH_ALIASES[foo]=npm\nfoo i lodash', ['npm:lodash']],
    ["BASH_ALIASES[foo]='npm i'\nfoo lodash", ['npm:lodash']],
    ["BASH_ALIASES[foo]='npm '\nBASH_ALIASES[bar]=i\nfoo bar lodash", ['npm:lodash']],
    ["BASH_ALIASES['foo']=npm\nfoo i lodash", ['npm:lodash']],
  ])('%j', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(unreadable(line)).toBeUndefined();
  });

  it.each([
    // -t lists and -x is an invalid option: bash binds nothing. A name with a slash never runs through the table.
    'hash -tp /usr/bin/npm foo; foo i lodash',
    'hash -p /usr/bin/npm -t foo; foo i lodash',
    'hash -x -p /usr/bin/npm foo; foo i lodash',
    'hash -p /usr/bin/npm; foo i lodash',
    'hash -p /usr/bin/npm a/b; a/b i lodash',
    // Reading the tables, or hashing by the PATH search, binds nothing.
    'hash npm 2>/dev/null && npm ci',
    'hash -r; npm ci',
    'echo "${BASH_CMDS[npm]}" ${#BASH_ALIASES[@]}; npm ci',
  ])('%j binds nothing', (line) => {
    expect(specs(line)).toEqual([]);
    expect(unreadable(line)).toBeUndefined();
  });

  it.each([
    'hash -p "$(command -v npm)" foo; foo i lodash',
    'hash -p /usr/bin/npm "$NAME"; foo i lodash',
    'hash $OPTIONS foo; foo i lodash',
    'BASH_CMDS[foo]=$(which npm); foo i lodash',
    'k=foo; BASH_CMDS[$k]=/usr/bin/npm; foo i lodash',
    'BASH_CMDS[foo]+=/usr/bin/npm; foo i lodash',
    'BASH_CMDS+=([foo]=/usr/bin/npm); foo i lodash',
    'BASH_CMDS=([foo]=/usr/bin/npm); foo i lodash',
    'declare -A BASH_CMDS=([foo]=/usr/bin/npm); foo i lodash',
    'declare BASH_CMDS[foo]=/usr/bin/npm; foo i lodash',
    "printf -v 'BASH_CMDS[foo]' %s /usr/bin/npm; foo i lodash",
    "read 'BASH_CMDS[foo]' <<< /usr/bin/npm; foo i lodash",
    'declare -n table=BASH_CMDS; table[foo]=/usr/bin/npm; foo i lodash',
    'echo ${BASH_CMDS[foo]:=/usr/bin/npm}; foo i lodash',
    'shopt -s expand_aliases\ndeclare -A BASH_ALIASES=([foo]=npm)\nfoo i lodash',
    'shopt -s expand_aliases\nBASH_ALIASES+=([foo]=npm)\nfoo i lodash',
    'BASH_ALIASES[foo]="$CMD"\nfoo i lodash',
    'eval "BASH_CMDS[foo]=$P"; foo i lodash',
  ])('%j asks', (line) => {
    const reason = unreadable(line);
    expect(reason).toMatch(/may then run a package manager$/u);
    expect(unreadableFix(reason ?? '')).toBe(
      'Run the package manager by its name, without hash -p, BASH_CMDS or BASH_ALIASES giving a command name another program, so depcurfew can check the command',
    );
  });

  it('names the command that rebinds', () => {
    expect(unreadable('BASH_CMDS+=([foo]=/usr/bin/npm); foo i lodash')).toBe(
      'BASH_CMDS+=([foo]=/usr/bin/npm); foo i lodash: "BASH_CMDS+=" may set BASH_CMDS in a way depcurfew does not read, and a command name may then run a package manager',
    );
    expect(unreadable('hash -p "$(command -v npm)" foo; foo i lodash')).toBe(
      'hash -p $(command -v npm) foo: the shell expands part of it, so depcurfew cannot tell which program hash gives a command name, and that name may then run a package manager',
    );
  });
});

describe('pipx inject, runpip, install-all and manifest sync', () => {
  it.each([
    // inject: the first operand is the environment, the others are packages, as for pipx install.
    ['pipx inject ruff requests', ['pip:pypi:requests']],
    ['pipx inject ruff requests rich==13.0', ['pip:pypi:requests', 'pip:pypi:rich==13.0']],
    ['pipx inject --include-apps ruff requests', ['pip:pypi:requests']],
    ['pipx inject -f ruff requests --with-suffix', ['pip:pypi:requests']],
    ['pipx inject --include-resources-from rich ruff requests', ['pip:pypi:requests']],
    ['pipx inject "$VENV" requests', ['pip:pypi:requests']],
    ['pipx inject ruff', []],
    // runpip: the words after the environment are pip's, under the pip backend and as uv pip under the uv backend.
    ['pipx runpip ruff install requests', ['pip:pypi:requests']],
    ['pipx runpip -v ruff install requests', ['pip:pypi:requests']],
    ['pipx runpip ruff -v install requests==2.0', ['pip:pypi:requests==2.0']],
    // argparse drops a -- before the words of pip, also one before the environment.
    ['pipx runpip ruff -- install requests', ['pip:pypi:requests']],
    ['pipx runpip -- ruff install requests', ['pip:pypi:requests']],
    // One word with blanks is split into pip's words, as pipx splits it.
    ['pipx runpip ruff "install requests rich"', ['pip:pypi:requests', 'pip:pypi:rich']],
    ['pipx runpip ruff list', []],
    ['pipx runpip ruff install -r requirements.txt', []],
    ['pipx uninject ruff requests', []],
    ['pipx manifest lock tools.toml', []],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(unreadable(line)).toBeUndefined();
  });

  it.each([
    ['pipx inject ruff -r reqs.txt', 'pipx inject ruff -r reqs.txt: -r installs the packages a file lists, which depcurfew does not read'],
    ['pipx inject ruff requests --requirement=reqs.txt', 'pipx inject ruff requests --requirement=reqs.txt: --requirement installs the packages a file lists, which depcurfew does not read'],
    ['pipx inject ruff --requ reqs.txt', 'pipx inject ruff --requ reqs.txt: --requirement installs the packages a file lists, which depcurfew does not read'],
    ['pipx install-all spec.json', 'pipx install-all spec.json: pipx install-all installs the packages a file lists, which depcurfew does not read'],
    ['pipx manifest sync tools.toml', 'pipx manifest sync tools.toml: pipx manifest sync installs the packages a file lists, which depcurfew does not read'],
  ])('%s asks', (line, reason) => {
    expect(unreadable(line)).toBe(reason);
    expect(unreadableFix(reason)).toBe('Name the packages in the command instead of in a file (pipx install <name>, pipx inject <environment> <name>), so depcurfew can check each of them');
  });

  it.each([
    ['pipx inject --index-url https://evil.example/simple ruff requests', '--index-url may point'],
    ['pipx inject ruff requests --pip-args=--pre', '--pip-args may point'],
    ['pipx runpip ruff install --index-url https://evil.example/simple requests', '--index-url may point'],
    ["pipx runpip ruff \"install 'requests>=2'\"", 'pipx runpip splits a lone word with blanks'],
    ['pipx runpip ruff "$ARGS"', 'is expanded by the shell'],
  ])('%s asks', (line, reason) => {
    expect(unreadable(line)).toContain(reason);
  });
});
