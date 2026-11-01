// Smoke test of the built CLI on the Node.js that runs this file, without network: CI runs it on old Node.js versions
// to find the lowest one depcurfew works on (decision D-103), and tests/runtime/smoke.test.ts on the current one.
// Plain JavaScript, because Node.js before 22.18 cannot run .ts files. Usage: node tests/runtime/smoke.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const fixture = (path) => join(root, 'tests', 'fixtures', path);
const scratch = mkdtempSync(join(tmpdir(), 'depcurfew-smoke-'));
const { FORCE_COLOR: _force, NO_COLOR: _no, ...plain } = process.env;
const failures = [];

function step(name, args, expected, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...plain, ...options.env }, input: options.input ?? '', cwd: options.cwd ?? root });
  const problems = [];
  if (result.error !== undefined) problems.push(`could not start: ${result.error.message}`);
  if (result.status !== expected.code) problems.push(`exit code ${result.status}, expected ${expected.code}`);
  if (expected.stderr !== false && result.stderr !== '') problems.push(`stderr: ${result.stderr.trim().split('\n').slice(0, 5).join(' | ')}`);
  if (expected.json === true) {
    try {
      JSON.parse(result.stdout);
    } catch {
      problems.push(`stdout is not JSON: ${result.stdout.slice(0, 200)}`);
    }
  }
  if (expected.contains !== undefined && !result.stdout.includes(expected.contains)) problems.push(`stdout lacks ${JSON.stringify(expected.contains)}`);
  console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}`);
  for (const problem of problems) console.log(`     ${problem}`);
  if (problems.length > 0) failures.push(name);
}

try {
  step('--version', ['--version'], { code: 0 });
  step('--help', ['--help'], { code: 0, contains: 'Usage: depcurfew' });
  step('explain --json', ['explain', '--json', fixture('repos/pnpm11-dependabot')], { code: 0, json: true });
  step('doctor on a fixture', ['doctor', fixture('doctor/bot-cooldown-mismatch/fires-dependabot-shorter/repo')], { code: 1, contains: 'bot-cooldown-mismatch' });
  step('doctor --sarif', ['doctor', '--sarif', fixture('doctor/bot-cooldown-mismatch/passes-consistent/repo')], { code: 0, json: true });
  const project = join(scratch, 'project');
  cpSync(fixture('repos/npm-basic'), project, { recursive: true });
  step('init', ['init', '--force', project], { code: 0 });
  step('apply --dry-run', ['apply', '--dry-run', project], { code: 0, stderr: false });
  step('apply', ['apply', project], { code: 0, stderr: false });
  step('apply again changes nothing', ['apply', '--json', project], { code: 0, json: true });
  step('doctor after apply', ['doctor', '--json', project], { code: 0, json: true });
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: project });
  step('check --hook without an install', ['check', '--hook', 'claude-code'], { code: 0 }, { input: event });
  step('check --hook with an unreadable event', ['check', '--hook', 'claude-code'], { code: 2, stderr: false }, { input: '{' });
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const userEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), PATH: join(scratch, 'empty-bin') };
  step('init --user', ['init', '--user'], { code: 0 }, { env: userEnv });
  step('doctor --user --json', ['doctor', '--user', '--json'], { code: 0, json: true }, { env: userEnv });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures.length === 0 ? `Node.js ${process.versions.node}: every step passed` : `Node.js ${process.versions.node}: ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
