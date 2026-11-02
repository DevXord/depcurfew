// The Claude Code hook and environment variables in PowerShell (decision D-138): parameters of the item cmdlets read as
// PowerShell binds them (any case, unambiguous prefixes, -Name:value, positions), backtick escapes and quotes removed
// from words before they are matched, New-Item, Set-Item, Rename-Item, Copy-Item, Move-Item and
// [Environment]::SetEnvironmentVariable on the Env: drive, and a question when the line uses the Env: drive with a name
// the reader cannot tell. A quoted composer is the command after &, or a string, not the variable COMPOSER. Composer
// scripts-aliases, which Composer reads only since 2.7.0, are read with and without them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanCommandLine, unreadableFix } from '../../src/check/command.ts';
import { powerShellEnvironment } from '../../src/check/powershell-env.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d138-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d138-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  const policy = { version: 1, cooldown: { minimum: '14d' }, installScripts: { default: 'deny' } };
  for (const [file, text] of Object.entries({ 'depcurfew.json': JSON.stringify(policy), ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string };

async function hook(command: string, root: string, tool = 'PowerShell'): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => root,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const decision = async (command: string, root: string, tool?: string) => (await hook(command, root, tool)).permissionDecision ?? 'none';
const powerShell = (line: string) => scanCommandLine(line, { shell: 'powershell' });

describe('the names the item cmdlets give on the Env: drive, bound as PowerShell binds parameters', () => {
  it.each([
    // -Name in any case, with a colon, and every unambiguous prefix (New-Item has no other parameter that starts with N).
    ['New-Item -Path Env: -Name:COMPOSER -Value x.json', ['COMPOSER']],
    ['New-Item -Path Env: -name:composer -Value x.json', ['composer']],
    ["New-Item -Name:'COMPOSER' -Path Env: -Value x.json", ['COMPOSER']],
    ['New-Item -Path Env: -Name: COMPOSER -Value x.json', ['COMPOSER']],
    ['New-Item -Path Env: -N COMPOSER -Value x.json', ['COMPOSER']],
    ['New-Item -Path Env: -Na COMPOSER -Value x.json', ['COMPOSER']],
    ['New-Item -Path Env: -Nam COMPOSER -Value x.json', ['COMPOSER']],
    ['ni Env: -Name COMPOSER -Va x.json', ['COMPOSER']],
    ['New-Item -Path Env: \u2013Name COMPOSER', ['COMPOSER']],
    ['Microsoft.PowerShell.Management\\New-Item -Path Env: -Name COMPOSER', ['COMPOSER']],
    // Rename-Item: -NewName by name, by prefix and by position.
    ['Rename-Item env:FOO COMPOSER', ['FOO', 'COMPOSER']],
    ['Rename-Item env:FOO -NewName COMPOSER', ['FOO', 'COMPOSER']],
    ['Rename-Item -NewName COMPOSER -Path env:FOO', ['COMPOSER', 'FOO']],
    ['Rename-Item -LiteralPath env:FOO COMPOSER', ['FOO', 'COMPOSER']],
    ['rni -N:COMPOSER env:FOO', ['COMPOSER', 'FOO']],
    ['Get-Item env:FOO | Rename-Item -NewName COMPOSER', ['FOO', 'COMPOSER']],
    // Copy-Item and Move-Item: the destination, also without the drive.
    ['Copy-Item env:FOO env:COMPOSER', ['FOO', 'COMPOSER']],
    ['Copy-Item -Path env:FOO -Destination COMPOSER', ['FOO', 'COMPOSER']],
    ['Move-Item env:FOO -Destination:COMPOSER', ['FOO', 'COMPOSER']],
    ['mi env:FOO COMPOSER', ['FOO', 'COMPOSER']],
    // Set-Item and Set-Content: the path, never the value.
    ['Set-Item -Path Env:FOO -Value COMPOSER', ['FOO']],
    ['Set-Item Env:FOO COMPOSER', ['FOO']],
    ['Set-Item -LiteralPath Env:FOO COMPOSER', ['FOO']],
    ['New-Item -Path Env: -Name FOO -Value COMPOSER', ['FOO']],
    ['Set-Content env:COMPOSER x.json', ['COMPOSER']],
    ['Set-Item -Path Env:A, Env:COMPOSER -Value x', ['A', 'COMPOSER']],
    ['Set-Item Environment::COMPOSER x', ['COMPOSER']],
    ['Set-Item Microsoft.PowerShell.Core\\Environment::COMPOSER x', ['COMPOSER']],
    ['Set-Item -Path "Env:\\COMPOSER" -Value x', ['COMPOSER']],
    // Backtick escapes and quotes inside a word are removed before the name is matched.
    ['Set-Item Env:COMPO`SER x.json', ['COMPOSER']],
    ["Set-Item Env:COMPO'SER' x.json", ['COMPOSER']],
    ['New-Item -Path Env: -Name COMPOSE`R -Value x.json', ['COMPOSER']],
    ['New-Item -Path Env: -Name `COMPOSER -Value x.json', ['COMPOSER']],
    // .NET and variables of the env: scope.
    ["[Environment]::SetEnvironmentVariable('COMPOSER', 'x.json')", ['COMPOSER']],
    ['[System.Environment]::SetEnvironmentVariable("COMPOSER", "x.json", "Process")', ['COMPOSER']],
    ['$env:COMPOSE`R = "x.json"', ['COMPOSER']],
    ['Write-Output ${env:COMPOSER}', ['COMPOSER']],
    // Inside brackets.
    ['& { New-Item -Path Env: -Name COMPOSER -Value x }', ['COMPOSER']],
    ['ForEach-Object { Rename-Item env:FOO COMPOSER }', ['FOO', 'COMPOSER']],
    // After a change of location to the Env: drive, a relative path is a variable.
    ['cd env:; Set-Item COMPOSER x.json', ['COMPOSER']],
    ['Set-Location -Path Env:\\; New-Item -Name COMPOSER -Value x.json', ['COMPOSER']],
    ['Push-Location Env:; Rename-Item FOO COMPOSER', ['FOO', 'COMPOSER']],
  ])('%s', (line, names) => {
    const found = powerShellEnvironment(line);
    expect(found.names).toEqual(names);
    expect(found.unresolved).toBeUndefined();
  });

  it.each([
    // What is no variable name: a string, the command after the call operator, a value, a file.
    ["Write-Output 'composer'", []],
    ["& 'composer' require monolog/monolog", []],
    ['& "composer" require monolog/monolog', []],
    ['Write-Host composer', []],
    ['Get-ChildItem env:', []],
    ['Get-ChildItem -Path Env:', []],
    ['Get-ChildItem env:NPM_*', ['NPM_*']],
    ['$v = (Get-Item env:PATH).Value', ['PATH']],
    ['Copy-Item composer.json.dist composer.json', []],
    ['Rename-Item composer.lock.bak composer.lock', []],
    ['New-Item -ItemType Directory -Name composer', []],
    ['New-Item -ItemType Directory -Path $dir', []],
  ])('names nothing it should not: %s', (line, names) => {
    const found = powerShellEnvironment(line);
    expect(found.names).toEqual(names);
    expect(found.unresolved).toBeUndefined();
  });

  it.each([
    // A name the shell builds or the binder cannot settle: the reader cannot tell the variable.
    ['New-Item -Path Env: -Name $n -Value x.json', 'New-Item -Path Env: -Name $n -Value x.json'],
    ['New-Item -Path Env: -Name ("COMPO" + "SER") -Value x.json', 'New-Item -Path Env: -Name ("COMPO" + "SER") -Value x.json'],
    ['Set-Item -Path "Env:$n" -Value x', 'Set-Item -Path "Env:$n" -Value x'],
    ["$p = 'Env:' + $n; Set-Item $p x", 'Set-Item $p x'],
    ['Set-Item Env:NPM_CONFIG_* x', 'Set-Item Env:NPM_CONFIG_* x'],
    ['Rename-Item env:FOO -NewName { $_.Name + "X" }', 'Rename-Item env:FOO -NewName { $_.Name + "X" }'],
    ['New-Item -Path Env: @p', 'New-Item -Path Env: @p'],
    ["$p = @{Path='Env:';Name='NPM_'+'CONFIG_REGISTRY'}; New-Item @p", 'New-Item @p'],
    ['New-Item -Path Env: -Nme COMPOSER', 'New-Item -Path Env: -Nme COMPOSER'],
    ['New-Item -Path Env: -Na`me COMPOSER', 'New-Item -Path Env: -Na`me COMPOSER'],
    // -W is WhatIf, WarningAction and WarningVariable, none of them a parameter of New-Item itself: ambiguous.
    ['New-Item -Path Env: -W -Name COMPOSER', 'New-Item -Path Env: -W -Name COMPOSER'],
    ["[Environment]::SetEnvironmentVariable($n, 'x')", "[Environment]::SetEnvironmentVariable($n, 'x')"],
    ["[Environment]::SetEnvironmentVariable('NPM_CONFIG_' + 'REGISTRY', 'x')", "[Environment]::SetEnvironmentVariable('NPM_CONFIG_' + 'REGISTRY', 'x')"],
    ["$m = [Environment]::SetEnvironmentVariable; $m.Invoke('COMPOSER', 'x')", '$m = [Environment]::SetEnvironmentVariable'],
    ["[Environment]::'SetEnvironmentVariable'('COMPOSER', 'x')", "[Environment]::'SetEnvironmentVariable'('COMPOSER', 'x')"],
    ["New-PSDrive -Name E -PSProvider Environment -Root ''", "New-PSDrive -Name E -PSProvider Environment -Root ''"],
  ])('cannot tell the name in %s', (line, shown) => {
    expect(powerShellEnvironment(line).unresolved).toBe(shown);
  });

  it('reads long lines in linear time', () => {
    for (const line of [`Set-Item Env:X ${'(a)'.repeat(60_000)}`, `Set-Item Env:a${' ,a'.repeat(60_000)} x`, `npm i x${'SetEnvironmentVariable(a)'.repeat(8000)}`, `npm i ${'`a'.repeat(100_000)}`]) {
      const start = performance.now();
      powerShellEnvironment(line);
      expect(performance.now() - start).toBeLessThan(1500);
    }
  });
});

describe('the hook asks about COMPOSER and the variables of every package manager set on the Env: drive (R1)', () => {
  it.each([
    'New-Item -Path Env: -Name:COMPOSER -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'New-Item -Path Env: -name:composer -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'New-Item -Path Env: -N COMPOSER -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'New-Item -Path Env: -Na COMPOSER -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'New-Item -Path Env: -Nam COMPOSER -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'Rename-Item env:FOO COMPOSER; composer require guzzlehttp/guzzle:8.3.0',
    'Rename-Item env:FOO -NewName COMPOSER; composer require guzzlehttp/guzzle:8.3.0',
    'Copy-Item env:FOO env:COMPOSER; composer require guzzlehttp/guzzle:8.3.0',
    'Move-Item env:FOO -Destination COMPOSER; composer require guzzlehttp/guzzle:8.3.0',
    'Set-Item Env:COMPO`SER x.json; composer require guzzlehttp/guzzle:8.3.0',
    '$env:COMPOSE`R = "x.json"; composer require guzzlehttp/guzzle:8.3.0',
    'New-Item -Path Env: -Name COMPOSE`R -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    "[Environment]::SetEnvironmentVariable('COMPOSER', 'x.json'); composer require guzzlehttp/guzzle:8.3.0",
    'Set-Item Env:NPM_CONFIG_REGI`STRY https://r.example; npm install lodash@4.17.21',
    'New-Item -Path Env: -Name:NPM_CONFIG_REGISTRY -Value https://r.example; npm install lodash@4.17.21',
    "Set-Item Env:npm_config_regi'stry' https://r.example; npm install lodash@4.17.21",
    'Set-Item Env:COMPOSER_NO_BLOCK`ING 1; composer install',
    // A name the reader cannot tell, for every package manager.
    '$n = "COMPO" + "SER"; New-Item -Path Env: -Name $n -Value x.json; composer require guzzlehttp/guzzle:8.3.0',
    'Set-Item -Path "Env:$n" -Value https://r.example; npm install lodash@4.17.21',
    "[Environment]::SetEnvironmentVariable($n, 'https://r.example'); pnpm add lodash@4.17.21",
    'Set-Item Env:YARN_NPM_* https://r.example; yarn add lodash@4.17.21',
    'New-Item -Path Env: -Name ("PIP_" + "INDEX_URL") -Value https://m.example/simple; pip install requests==2.34.2',
    'Rename-Item env:FOO -NewName { "NPM_CONFIG_REGISTRY" }; npm ci',
  ])('%s', async (command) => {
    expect([command, await decision(command, project({ 'composer.json': '{}\n', 'package.json': '{"name":"a"}\n' }))]).toEqual([command, 'ask']);
  });

  it('says which command it cannot read and what to do', () => {
    const reason = powerShell('Set-Item -Path "Env:$n" -Value https://r.example; npm install lodash@4.17.21').unreadable;
    expect(reason).toBe(
      'Set-Item -Path "Env:$n" -Value https://r.example; npm install lodash@4.17.21: "Set-Item -Path "Env:$n" -Value https://r.example" uses an environment variable whose name depcurfew does not read, which may point the package manager at another registry or weaken the release-age delay or the install-script settings of the project',
    );
    expect(unreadableFix(reason ?? '')).toBe(
      "Set the variable as $env:NAME = 'value' with its name written out, or leave it out, so depcurfew can tell which variable the command sets",
    );
  });

  it.each([
    ['Set-Item Env:BUN_CONFIG_REGIS`TRY https://r.example; bun add lodash@4.17.21', 'BUN_CONFIG_REGISTRY may point the package manager at another registry'],
    ['Rename-Item env:FOO YARN_NPM_REGISTRY_SERVER; yarn add lodash@4.17.21', 'YARN_NPM_REGISTRY_SERVER may point the package manager at another registry'],
    ['New-Item -Path Env: -N:pnpm_config_registry -Value https://r.example; pnpm add lodash@4.17.21', 'pnpm_config_registry may point the package manager at another registry'],
    ['Copy-Item env:FOO env:PIP_INDEX_U`RL; pip install requests==2.34.2', 'PIP_INDEX_URL may point the package manager at another registry'],
    ['Set-Item Env:npm_config_ignore_scri`pts false; npm ci', 'npm_config_ignore_scripts is set in a way depcurfew does not read'],
  ])('names the variable of each package manager: %s', (line, reason) => {
    expect(powerShell(line).unreadable).toContain(reason);
  });

  it('gives no decision where the line names no variable that matters', async () => {
    const root = project({ 'composer.json': '{}\n', 'package.json': '{"name":"a"}\n' });
    for (const command of [
      'Get-ChildItem env:; npm install lodash@4.17.21',
      'Get-ChildItem env:NPM_*; npm install lodash@4.17.21',
      '$v = (Get-Item env:PATH).Value; npm install lodash@4.17.21',
      'Set-Item Env:FOO -Value COMPOSER; composer require guzzlehttp/guzzle:8.3.0',
      'New-Item -ItemType Directory -Path $dir; npm install lodash@4.17.21',
      'Copy-Item composer.json.dist composer.json; composer require guzzlehttp/guzzle:8.3.0',
      'Set-Item -Path "Env:$n" -Value x; Write-Output done',
    ]) {
      expect([command, await decision(command, root)]).toEqual([command, 'none']);
    }
  });
});

describe('a quoted composer is the command or a string, not the variable COMPOSER (R4)', () => {
  it('decides as in Bash', async () => {
    const root = project({ 'composer.json': '{}\n' });
    expect(await decision('composer require monolog/monolog', root, 'Bash')).toBe('none');
    for (const command of [
      "& 'composer' require monolog/monolog",
      '& "composer" require monolog/monolog',
      "Write-Output 'composer'; composer require monolog/monolog",
      'Write-Output "composer"; composer require monolog/monolog',
    ]) {
      expect([command, await decision(command, root)]).toEqual([command, 'none']);
    }
    expect(await decision("& 'composer' require guzzlehttp/guzzle", root)).toBe('deny');
  });
});

describe('Composer script aliases, which Composer reads only since 2.7.0 (R2)', () => {
  it('checks the word as the Composer command when it is one without scripts-aliases', async () => {
    const root = project({ 'composer.json': JSON.stringify({ scripts: { foo: 'echo' }, 'scripts-aliases': { foo: ['r'] } }) });
    // Composer 2.7 and later run the script foo; 2.2 to 2.6 run require, the command r stands for without the alias.
    expect(await decision('composer r guzzlehttp/guzzle', root, 'Bash')).toBe('deny');
    expect(await decision('composer foo guzzlehttp/guzzle', root, 'Bash')).toBe('none');
  });

  it('still reads a script without aliases as a script', async () => {
    const root = project({ 'composer.json': JSON.stringify({ scripts: { inst: '@composer require' } }) });
    expect(await decision('composer inst guzzlehttp/guzzle', root, 'Bash')).toBe('none');
  });
});
