// Smoke test of the built CLI on the Node.js that runs this file, without network: CI runs it on old Node.js versions
// to find the lowest one depcurfew works on (decision D-103), and tests/runtime/smoke.test.ts on the current one.
// Plain JavaScript, because Node.js before 22.18 cannot run .ts files. Usage: node tests/runtime/smoke.mjs
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const fixture = (path) => join(root, 'tests', 'fixtures', path);
const scratch = mkdtempSync(join(tmpdir(), 'depcurfew-smoke-'));
const { FORCE_COLOR: _force, NO_COLOR: _no, ...plain } = process.env;
const failures = [];

/** Runs the CLI without blocking, so the local registry below can answer it. */
function exec(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...plain, ...options.env }, cwd: options.cwd ?? root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: undefined }));
    child.stdin.end(options.input ?? '');
  });
}

async function step(name, args, expected, options = {}) {
  const result = await exec(args, options);
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

// A registry on this computer that answers with the recorded documents of tests/fixtures/registry, so that check
// runs its fetch on this Node.js without the network.
const registry = createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').slice(1)).replace('/', '__');
  let body;
  try {
    body = readFileSync(fixture(`registry/${name}.json`), 'utf8');
  } catch {
    body = '{"status": 404}';
  }
  const status = JSON.parse(body).status === 404 ? 404 : 200;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(status === 404 ? '{"error":"Not found"}' : body);
});

async function main() {
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const registryUrl = `http://127.0.0.1:${registry.address().port}/`;
  try {
    await step('--version', ['--version'], { code: 0 });
    await step('--help', ['--help'], { code: 0, contains: 'Usage: depcurfew' });
    await step('explain --json', ['explain', '--json', fixture('repos/pnpm11-dependabot')], { code: 0, json: true });
    await step('doctor on a fixture', ['doctor', fixture('doctor/bot-cooldown-mismatch/fires-dependabot-shorter/repo')], { code: 1, contains: 'bot-cooldown-mismatch' });
    await step('doctor --sarif', ['doctor', '--sarif', fixture('doctor/bot-cooldown-mismatch/passes-consistent/repo')], { code: 0, json: true });
    const project = join(scratch, 'project');
    cpSync(fixture('repos/npm-basic'), project, { recursive: true });
    await step('init', ['init', '--force', project], { code: 0 });
    await step('apply --dry-run', ['apply', '--dry-run', project], { code: 0, stderr: false });
    await step('apply', ['apply', project], { code: 0, stderr: false });
    await step('apply again changes nothing', ['apply', '--json', project], { code: 0, json: true });
    await step('doctor after apply', ['doctor', '--json', project], { code: 0, json: true });
    const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: project });
    await step('check --hook without an install', ['check', '--hook', 'claude-code'], { code: 0 }, { input: event });
    await step('check --hook with an unreadable event', ['check', '--hook', 'claude-code'], { code: 2, stderr: false }, { input: '{' });
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    const userEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), PATH: join(scratch, 'empty-bin') };
    await step('init --user', ['init', '--user'], { code: 0 }, { env: userEnv });
    await step('doctor --user --json', ['doctor', '--user', '--json'], { code: 0, json: true }, { env: userEnv });
    await step('check --json against a local registry', ['check', '--json', '--registry', registryUrl, 'lodash@4.17.21'], { code: 0, json: true });
    await step('check of a name the registry does not know', ['check', '--json', '--registry', registryUrl, 'this-package-does-not-exist-xyz-123'], { code: 1, json: true });
    // The hook asks about a registry named in the command, so the project's .npmrc names this one.
    appendFileSync(join(project, '.npmrc'), `registry=${registryUrl}\n`);
    const install = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install this-package-does-not-exist-xyz-123' }, cwd: project });
    await step('check --hook denies a made-up name', ['check', '--hook', 'claude-code'], { code: 0, json: true, contains: 'deny' }, { input: install });
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? `Node.js ${process.versions.node}: every step passed` : `Node.js ${process.versions.node}: ${failures.length} failed`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`FAIL the smoke test itself: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
