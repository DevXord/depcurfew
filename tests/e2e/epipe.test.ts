// The built executable when the program reading its output stops early (depcurfew doctor --sarif | head -1): the
// closed pipe ends the output quietly, without a stack trace, and the exit code is the one of the command.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { bin: Record<string, string> };
const binPath = fileURLToPath(new URL(pkg.bin['depcurfew'] ?? '', root));
const { FORCE_COLOR: _force, NO_COLOR: _no, ...plainEnv } = process.env;

/** Runs depcurfew with its stdout connected to a pipe whose reading end is already closed. */
function withClosedStdout(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env: plainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('built depcurfew executable with a closed stdout', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) throw new Error(`${binPath} does not exist. Run \`npm test\` (it builds first) or \`npm run build\`.`);
  });

  it.each([['doctor', '--sarif'], ['doctor', '--json'], ['explain', '--json'], ['apply', '--dry-run', '--json']])('%s %s ends quietly with the exit code of the command', async (...args) => {
    const directory = fileURLToPath(new URL('tests/fixtures/doctor/config-drift/fires-hand-edited/repo', root));
    const expected = spawnSync(process.execPath, [binPath, ...args, directory], { env: plainEnv }).status;
    const result = await withClosedStdout(...args, directory);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(expected);
  });
});
