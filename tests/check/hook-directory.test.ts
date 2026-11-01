// The Claude Code hook checks each install with the policy of the directory it runs in (decision D-118): a cd before
// it, pushd, PowerShell's Set-Location and the options that move one command (npm --prefix, pnpm -C, yarn --cwd, bun
// --cwd, uv --directory, poetry -C). The rule of D-113 applies to that directory instead of the working directory, a
// directory outside the project gets only the project's policy, and an install whose directory cannot be told asks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix = 'depcurfew-d118-'): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(created);
  return created;
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

const policy = (document: object) => JSON.stringify({ version: 1, ...document });
/** A path as a command line writes it, with / also on Windows. */
const written = (path: string) => path.split(sep).join('/');

/**
 * The tester's repository: a git repository whose root policy allows releases older than an hour, and pkgs/strict with
 * a policy of 90 days. @types/node@26.6.6 was published 17 hours before NOW.
 */
function repository(files: Record<string, string> = {}, root: object = { cooldown: { minimum: '1h' } }): string {
  const created = directory();
  mkdirSync(join(created, '.git'));
  write(created, {
    'depcurfew.json': policy(root),
    'package.json': '{"name":"root","private":true}',
    'pkgs/strict/depcurfew.json': policy({ cooldown: { minimum: '90d' } }),
    'pkgs/strict/package.json': '{"name":"strict","private":true}',
    'pkgs/other/package.json': '{"name":"other","private":true}',
    ...files,
  });
  return created;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, cwd: string, projectDir: string | undefined, options: { tool?: string; fetch?: FetchLike } = {}): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: options.tool ?? 'Bash', tool_input: { command }, cwd });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => projectDir,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const STRICT = 'pkgs/strict/depcurfew.json requires 90 days';

describe('the hook checks an install with the policy of the directory it runs in', () => {
  it('denies cd pkgs/strict && npm install @types/node@26.6.6 (T18)', async () => {
    const root = repository();
    // In the root the project's policy allows it.
    expect((await hook('npm install @types/node@26.6.6', root, root)).permissionDecision).toBeUndefined();
    const answer = await hook('cd pkgs/strict && npm install @types/node@26.6.6', root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(`- @types/node@26.6.6: @types/node@26.6.6 was published`);
    expect(answer.permissionDecisionReason).toContain(STRICT);
    expect(answer.permissionDecisionReason).toContain(
      'Besides the policy of the project (CLAUDE_PROJECT_DIR), pkgs/strict/depcurfew.json also applies to what the command installs in pkgs/strict; the stricter answer counts.',
    );
    // The same from the working directory itself, as before.
    expect((await hook('npm install @types/node@26.6.6', join(root, 'pkgs', 'strict'), root)).permissionDecision).toBe('deny');
    // Without CLAUDE_PROJECT_DIR the project is the one of the working directory.
    expect((await hook('cd pkgs/strict && npm install @types/node@26.6.6', root, undefined)).permissionDecisionReason).toContain(STRICT);
  });

  it('says how long to wait by the longer delay when both policies deny the release', async () => {
    // The root denies it too (1 day); the 90 days of pkgs/strict/depcurfew.json say how long to wait.
    const root = repository({}, { cooldown: { minimum: '1d' } });
    const answer = await hook('cd pkgs/strict && npm install @types/node@26.6.6', root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
    expect(answer.permissionDecisionReason).toContain('is 90 days old');
    expect(answer.permissionDecisionReason).not.toContain('is 1 day old');
  });

  it.each([
    ['cd pkgs/strict; npm i @types/node@26.6.6', 'Bash'],
    ['cd "pkgs/strict" || exit 1\nnpm i @types/node@26.6.6', 'Bash'],
    ['pushd pkgs/strict && npm i @types/node@26.6.6', 'Bash'],
    ['cd pkgs && cd strict && npm i @types/node@26.6.6', 'Bash'],
    ["sh -c 'cd pkgs/strict && npm i @types/node@26.6.6'", 'Bash'],
    ['cd pkgs/strict; npm i @types/node@26.6.6', 'PowerShell'],
    ['Set-Location -Path pkgs/strict; npm i @types/node@26.6.6', 'PowerShell'],
    ["Set-Location -LiteralPath 'pkgs/strict'; npm i @types/node@26.6.6", 'PowerShell'],
    ['sl pkgs/strict; npm i @types/node@26.6.6', 'PowerShell'],
    ['Push-Location pkgs/strict; npm i @types/node@26.6.6', 'PowerShell'],
    ['npm --prefix pkgs/strict install @types/node@26.6.6', 'Bash'],
    ['npm -C pkgs/strict i @types/node@26.6.6', 'Bash'],
    ['pnpm -C pkgs/strict add @types/node@26.6.6', 'Bash'],
    ['pnpm --dir pkgs/strict add @types/node@26.6.6', 'Bash'],
    ['yarn --cwd pkgs/strict add @types/node@26.6.6', 'Bash'],
    ['yarn add @types/node@26.6.6 --cwd pkgs/strict', 'Bash'],
    ['bun add @types/node@26.6.6 --cwd pkgs/strict', 'Bash'],
  ])('denies %s (%s)', async (command, tool) => {
    const root = repository();
    const answer = await hook(command, root, root, { tool });
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
  });

  it.each([
    ['uv --directory pkgs/strict add requests==2.32.1'],
    ['uv add --project pkgs/strict requests==2.32.1'],
    ['poetry -C pkgs/strict add requests==2.32.1'],
    ['poetry add requests==2.32.1 --directory pkgs/strict'],
    ['cd pkgs/strict && pip install requests==2.32.1'],
  ])('denies %s with the policy of that directory', async (command) => {
    const root = repository({ 'pkgs/strict/depcurfew.json': policy({ cooldown: { minimum: '3000d' } }) });
    expect((await hook(command.replace(/ --directory pkgs\/strict| --project pkgs\/strict| -C pkgs\/strict|cd pkgs\/strict && /u, ''), root, root)).permissionDecision).toBeUndefined();
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain('pkgs/strict/depcurfew.json requires 3000 days');
  });

  it('ends the change with its subshell, and follows cd - and popd back', async () => {
    const root = repository();
    for (const command of [
      '(cd pkgs/strict) && npm i @types/node@26.6.6',
      'cd pkgs/strict && cd - && npm i @types/node@26.6.6',
      'pushd pkgs/strict && popd && npm i @types/node@26.6.6',
      "bash -c 'cd pkgs/strict'; npm i @types/node@26.6.6",
    ]) {
      expect((await hook(command, root, root)).permissionDecision, command).toBeUndefined();
    }
    expect((await hook('Push-Location pkgs/strict; Pop-Location; npm i @types/node@26.6.6', root, root, { tool: 'PowerShell' })).permissionDecision).toBeUndefined();
  });

  it('checks two installs in two directories of one command, each with its own policies, and looks each package up once', async () => {
    const root = repository({}, { cooldown: { minimum: '1h' }, installScripts: { default: 'deny' } });
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      return recordedFetch(url, init);
    };
    const answer = await hook('npm i esbuild @types/node@26.6.6 && cd pkgs/strict && npm i @types/node@26.6.6', root, root, { fetch });
    expect(answer.permissionDecision).toBe('deny');
    // esbuild breaks the project's policy in the root; @types/node only the policy of pkgs/strict.
    expect(answer.permissionDecisionReason).toContain('- esbuild: esbuild@0.28.2 runs install scripts (postinstall) that depcurfew.json does not allow');
    expect(answer.permissionDecisionReason?.match(/- @types\/node@26\.6\.6:/gu)).toHaveLength(1);
    expect(answer.permissionDecisionReason).toContain(STRICT);
    expect(urls.filter((url) => /\/@types(?:%2f|\/)node$/iu.test(url))).toHaveLength(1);
  });

  it('gives a directory outside the project only the policy of the project', async () => {
    const root = repository({}, { cooldown: { minimum: '90d' } });
    const outside = directory();
    mkdirSync(join(outside, '.git'));
    write(outside, { 'depcurfew.json': policy({ cooldown: { minimum: '1h' } }) });
    // A policy found from the outside directory never relaxes the project's.
    expect((await hook(`cd ${written(outside)} && npm i @types/node@26.6.6`, root, root)).permissionDecisionReason).toContain('requires 90 days');
    expect((await hook(`npm --prefix ${written(outside)} i @types/node@26.6.6`, root, root)).permissionDecision).toBe('deny');
    // Nor does it tighten it: the outside policy is not used at all.
    const lenient = repository({ 'pkgs/strict/depcurfew.json': policy({}) }, { cooldown: { minimum: '1h' } });
    write(outside, { 'depcurfew.json': policy({ cooldown: { minimum: '3000d' } }) });
    expect((await hook(`cd ${written(outside)} && npm i @types/node@26.6.6`, lenient, lenient)).permissionDecision).toBeUndefined();
    // Without a policy of the project, the nearest one from the working directory applies.
    const bare = directory();
    mkdirSync(join(bare, '.git'));
    write(bare, { 'app/depcurfew.json': policy({ cooldown: { minimum: '90d' } }) });
    expect((await hook(`cd ${written(outside)} && npm i @types/node@26.6.6`, join(bare, 'app'), bare)).permissionDecisionReason).toContain('requires 90 days');
  });

  it('asks about an install whose directory it cannot tell, and says what to do', async () => {
    const root = repository();
    const answer = await hook('cd "$PKG_DIR" && npm install @types/node@26.6.6', root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toBe(
      'depcurfew cannot vouch for what this command installs:\n- depcurfew cannot tell which directory "npm install @types/node@26.6.6" runs in: the shell expands the directory of "cd $PKG_DIR". Fix: Run the install from that directory, or change to it with a path written out (cd path/to/project && …), so depcurfew checks it with the policy that applies there',
    );
    // The project's policy still applies wherever it runs, so what it denies is denied.
    const strict = repository({}, { cooldown: { minimum: '90d' } });
    expect((await hook('cd "$PKG_DIR" && npm install @types/node@26.6.6', strict, strict)).permissionDecision).toBe('deny');
    // Installs without package names keep the policies of the working directory.
    expect(await hook('cd "$PKG_DIR" && npm ci', root, root)).toEqual({});
    const scripts = repository({}, { installScripts: { default: 'deny' } });
    expect((await hook('cd "$PKG_DIR" && npm ci --ignore-scripts=false', scripts, scripts)).permissionDecisionReason).toContain('lets dependency install scripts run that depcurfew.json restricts');
  });

  it('judges an option that weakens the policy by the policies of the directory it runs in', async () => {
    const root = repository();
    expect(await hook('npm ci --min-release-age=1', root, root)).toEqual({});
    expect((await hook('cd pkgs/strict && npm ci --min-release-age=1', root, root)).permissionDecisionReason).toContain(
      // The file that sets the delay, relative to the project (decision D-123).
      'sets the release-age delay to 1 day, shorter than the 90 days in pkgs/strict/depcurfew.json',
    );
  });

  it("reads the .npmrc and the Yarn settings of the install's directory", async () => {
    const root = repository({
      'pkgs/other/.npmrc': 'registry=https://evil.example/\n',
      'pkgs/yarn/package.json': '{"name":"yarn","private":true}',
      'pkgs/yarn/.yarnrc.yml': 'npmRegistryServer: "https://yarn.evil.example"\n',
      'pkgs/bare/.npmrc': 'registry=https://bare.evil.example/\n',
    });
    expect(await hook('npm i lodash@4.17.21', root, root)).toEqual({});
    const npm = await hook('cd pkgs/other && npm i lodash@4.17.21', root, root);
    expect(npm.permissionDecision).toBe('ask');
    expect(npm.permissionDecisionReason).toContain('- lodash@4.17.21: the install would use the registry https://evil.example/ from pkgs/other/.npmrc (line 1)');
    expect(await hook('yarn add lodash@4.17.21', root, root)).toEqual({});
    const yarn = await hook('cd pkgs/yarn && yarn add lodash@4.17.21', root, root);
    expect(yarn.permissionDecisionReason).toContain('the install would use the registry https://yarn.evil.example from pkgs/yarn/.yarnrc.yml (line 1)');
    // pkgs/bare has no package.json, so npm run there takes the root as its prefix; with --prefix it is pkgs/bare itself.
    expect(await hook('cd pkgs/bare && npm i lodash@4.17.21', root, root)).toEqual({});
    expect((await hook('npm --prefix pkgs/bare i lodash@4.17.21', root, root)).permissionDecisionReason).toContain('from pkgs/bare/.npmrc (line 1)');
  });

  it('asks about a command that installs in more directories than it checks', async () => {
    const root = repository();
    const command = Array.from({ length: 21 }, (_, index) => `npm --prefix d${index} i lodash@4.17.21`).join(' && ');
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain(
      '- the command installs in more than 20 directories, and depcurfew checks at most 20 directories in one command. Fix: Install the packages in smaller groups',
    );
  });

  it('stays silent about commands that install nothing, wherever they run', async () => {
    const root = repository();
    for (const command of ['cd "$DIR" && ls', 'cd pkgs/strict && npm test', 'cd ~ && git status', 'pushd /tmp && popd', 'for d in pkgs/*; do (cd "$d" && make); done']) {
      expect(await hook(command, root, root), command).toEqual({});
    }
  });
});
