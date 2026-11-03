// Decision D-160 in the scanner: the options a download command takes where its tool reads them, also before the
// subcommand (pnpm --package=x dlx y, npm --package=x exec y, yarn -p x dlx y, bun --package=x x y) and, for npm exec
// and npm x, after the arguments up to --; and the literal specs of a command that a word the shell expands leaves
// unreadable, kept aside for the local OSV.dev data as D-155 keeps those of a command an option points at another
// registry.
import { describe, expect, it } from 'vitest';
import { scanCommandLine, unreadableFix } from '../../src/check/command.ts';

const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);
const aside = (line: string) => scanCommandLine(line).aside?.map((request) => `${request.tool}:${request.spec}`);

describe('options of a download command before its subcommand', () => {
  it.each([
    // pnpm 10 and 11 parse the whole command line again with the options of dlx; pnpm 12 moves them after dlx.
    ['pnpm --package=cutekitten-test@1.0.1 dlx kitten', ['pnpm:cutekitten-test@1.0.1']],
    ['pnpm --package cutekitten-test@1.0.1 dlx kitten', ['pnpm:cutekitten-test@1.0.1']],
    ['pnpm --package=yo --package generator-webapp dlx yo webapp', ['pnpm:yo', 'pnpm:generator-webapp']],
    ['pnpm --package yo dlx --package generator-webapp yo webapp', ['pnpm:yo', 'pnpm:generator-webapp']],
    ["pnpm --package cowsay --package lolcatjs -c dlx 'echo hi | cowsay | lolcatjs'", ['pnpm:cowsay', 'pnpm:lolcatjs']],
    ["pnpm --package cowsay -c dlx 'npm i lodash'", ['pnpm:cowsay', 'npm:lodash']],
    ['pnpm --filter web dlx create-vue my-app', ['pnpm:create-vue']],
    // npm parses every option of the line with nopt, wherever it stands.
    ['npm --package=cutekitten-test@1.0.1 exec kitten', ['npm:cutekitten-test@1.0.1']],
    ['npm --package cutekitten-test@1.0.1 x kitten', ['npm:cutekitten-test@1.0.1']],
    ["npm --call 'npm i lodash' exec", ['npm:lodash']],
    ["npm -c 'npm i lodash' exec", ['npm:lodash']],
    // Clipanion takes the options of a command before its path too.
    ['yarn -p cutekitten-test@1.0.1 dlx kitten', ['yarn:cutekitten-test@1.0.1']],
    ['yarn --package=cutekitten-test@1.0.1 dlx kitten', ['yarn:cutekitten-test@1.0.1']],
    ['yarn -p typescript create vite', ['yarn:typescript', 'yarn:create-vite']],
    // bun takes the first word that is no option for the command, so only an option with its value in the same word
    // reaches bun x, which then reads it.
    ['bun --package=cutekitten-test@1.0.1 x kitten', ['bun:cutekitten-test@1.0.1']],
    ['bun -p=cutekitten-test@1.0.1 x kitten', ['bun:cutekitten-test@1.0.1']],
    ['bun --package x x kitten', ['bun:x']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('leaves the commands where an option before the subcommand is not that command as they were', () => {
    // bun runs cutekitten-test@1.0.1 as a script, with x and kitten as its arguments.
    expect(specs('bun --package cutekitten-test@1.0.1 x kitten')).toEqual([]);
    // pnpm exec has no --package: pnpm stops at an unknown option.
    expect(specs('pnpm --package=cutekitten-test@1.0.1 exec kitten')).toEqual([]);
    // uv and pipx take --from and --spec only after their run command.
    expect(specs('uvx --from cutekitten kitten')).toEqual(['uv:pypi:cutekitten']);
    expect(specs('pipx run --spec cutekitten kitten')).toEqual(['pip:pypi:cutekitten']);
    // Options before the subcommand of an install still count as before.
    expect(specs('npm --save-exact i lodash')).toEqual(['npm:lodash']);
    expect(specs('pnpm --filter web add react')).toEqual(['pnpm:react']);
  });

  it('reads an option before the subcommand that points at another registry as before', () => {
    expect(scanCommandLine('pnpm --registry=https://npm.evil.example --package=cutekitten-test@1.0.1 dlx kitten').unreadable).toContain('--registry may point');
    expect(aside('pnpm --registry=https://npm.evil.example --package=cutekitten-test@1.0.1 dlx kitten')).toEqual(['pnpm:cutekitten-test@1.0.1']);
  });

  it('counts an option before the subcommand that weakens the delay once', () => {
    expect(scanCommandLine('npm --min-release-age=0 --package=x exec y').overrides).toEqual([expect.objectContaining({ written: '--min-release-age=0', delay: '0' })]);
  });
});

describe('npm exec and npm x read their options among the arguments, up to --', () => {
  it.each([
    // npm-exec.md: npm exec foo@latest bar --package=@npmcli/foo resolves @npmcli/foo and runs foo@latest bar.
    ['npm exec foo@latest bar --package=@npmcli/foo', ['npm:@npmcli/foo']],
    ['npm exec kitten --package=cutekitten-test@1.0.1', ['npm:cutekitten-test@1.0.1']],
    ['npm x kitten --package cutekitten-test@1.0.1 --yes', ['npm:cutekitten-test@1.0.1']],
    // After -- they are arguments of the command, and npx puts -- before its first argument.
    ['npm exec -- foo@latest bar --package=@npmcli/foo', ['npm:foo@latest']],
    ['npm exec foo -- bar --package=@npmcli/foo', ['npm:foo']],
    ['npx foo@latest bar --package=@npmcli/foo', ['npm:foo@latest']],
    ['npm exec -- foo "$X"', ['npm:foo']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('reads a command line of --call there too, and an option that points at another registry', () => {
    expect(specs("npm exec --package=cowsay -- cowsay hi")).toEqual(['npm:cowsay']);
    expect(scanCommandLine('npm exec foo --registry=https://npm.evil.example').unreadable).toContain('--registry may point');
    expect(scanCommandLine('npm exec foo --min-release-age=0').overrides).toEqual([expect.objectContaining({ written: '--min-release-age=0' })]);
  });

  it.each(['npm exec foo "$X"', 'npm exec foo $X', 'npm x foo src/*.ts', 'npm exec foo bar $(cat args)'])('%s: a word the shell expands may be an option of npm', (line) => {
    const scan = scanCommandLine(line);
    expect(scan.unreadable).toMatch(/is expanded by the shell, and npm (exec|x) reads the options among its arguments up to --$/u);
    expect(unreadableFix(scan.unreadable ?? '')).toBe('Put -- before the command that npm exec or npm x runs (npm exec -- <command> …), so npm does not read its arguments as its own options');
    expect(aside(line)).toEqual(['npm:foo']);
  });
});

describe('a word the shell expands keeps the literal specs of its command aside', () => {
  it.each([
    ['npm i cutekitten-test@1.0.1 "$X"', '"$X" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i cutekitten-test@1.0.1 *', '"*" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i cutekitten-test@1.0.1 {a,b}', '"{a,b}" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i cutekitten-test@1.0.1 $(true)', '"$(true)" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i cutekitten-test@1.0.1 --foo=$X', '"--foo=$X" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i --tag "$T" cutekitten-test@1.0.1', '"--tag $T" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['npm i "$X" lodash cutekitten-test@1.0.1', '"$X" is expanded by the shell', ['npm:lodash', 'npm:cutekitten-test@1.0.1']],
    ['npm --foo=$X i cutekitten-test@1.0.1', '"--foo=$X" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['pnpm add cutekitten-test@1.0.1 "$X"', '"$X" is expanded by the shell', ['pnpm:cutekitten-test@1.0.1']],
    ['npx -p cutekitten-test@1.0.1 "$X"', '"$X" is expanded by the shell', ['npm:cutekitten-test@1.0.1']],
    ['pip install wallet-tracking==1.0.0 $X', '"$X" is expanded by the shell', ['pip:pypi:wallet-tracking==1.0.0']],
    ['pip --foo=$O install wallet-tracking==1.0.0', '"--foo=$O" is expanded by the shell', ['pip:pypi:wallet-tracking==1.0.0']],
    ['uv pip install "$X" wallet-tracking==1.0.0', '"$X" is expanded by the shell', ['uv:pypi:wallet-tracking==1.0.0']],
    ['composer require intercom/intercom-php:5.0.2 $X', '"$X" is expanded by the shell', ['composer:composer:intercom/intercom-php:5.0.2']],
    ['composer require intercom/intercom-php 5.0.2 "$X"', '"$X" is expanded by the shell', ['composer:composer:intercom/intercom-php:5.0.2']],
    ['composer require --foo=$X intercom/intercom-php:5.0.2', '"--foo=$X" is expanded by the shell', ['composer:composer:intercom/intercom-php:5.0.2']],
  ])('%s', (line, reason, kept) => {
    const scan = scanCommandLine(line);
    expect(scan.requests).toEqual([]);
    expect(scan.unreadable).toContain(reason);
    expect(aside(line)).toEqual(kept);
  });

  it('pairs a Composer constraint only with the name right before it, not across a word the shell expands', () => {
    expect(aside('composer require intercom/intercom-php "$X" 5.0.2')).toEqual(['composer:composer:intercom/intercom-php', 'composer:composer:5.0.2']);
  });

  it('keeps the requests of the other commands of the line, and adds no aside where nothing was left out', () => {
    const scan = scanCommandLine('npm i lodash@4.17.21 && npm i cutekitten-test@1.0.1 "$X"');
    expect(scan.requests.map((request) => request.spec)).toEqual(['lodash@4.17.21']);
    expect(aside('npm i lodash@4.17.21 && npm i cutekitten-test@1.0.1 "$X"')).toEqual(['npm:lodash@4.17.21', 'npm:cutekitten-test@1.0.1']);
    expect(scanCommandLine('npm i lodash@4.17.21').aside).toBeUndefined();
    // A subcommand the shell expands names no command to read.
    expect(scanCommandLine('npm $CMD cutekitten-test@1.0.1').aside).toBeUndefined();
  });

  it('stops at the package word of a run command the shell expands', () => {
    // npx "$X" names the package with $X; what follows are its arguments, not packages.
    expect(aside('npx "$X" cutekitten-test@1.0.1')).toEqual([]);
    expect(aside('npx -p cutekitten-test@1.0.1 "$X" foo')).toEqual(['npm:cutekitten-test@1.0.1']);
  });
});
