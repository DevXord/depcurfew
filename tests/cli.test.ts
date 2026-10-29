import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../src/cli/run.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('depgate CLI', () => {
  it.each([['--help'], ['-h'], ['help']])('%s prints usage and the command list', async (flag) => {
    const result = await exec(flag);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Usage: depgate <command> [options]');
    for (const command of ['init', 'apply', 'doctor', 'explain']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${command}\\s`, 'm'));
    }
    expect(result.stderr).toBe('');
  });

  it('prints help when called without arguments', async () => {
    const result = await exec();
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Usage: depgate');
  });

  it.each([['--version'], ['-v']])('%s prints the package version', async (flag) => {
    const result = await exec(flag);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });

  it('rejects an unknown command with a usage error', async () => {
    const result = await exec('frobnicate');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).toContain('depgate --help');
  });

  it('rejects an unknown flag with a usage error', async () => {
    const result = await exec('--frobnicate');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--frobnicate');
  });

  it('lists the options of apply in the help', async () => {
    const result = await exec('--help');
    expect(result.stdout).toContain('apply [directory]:');
    expect(result.stdout).toMatch(/^\s+--dry-run\s+Print a diff/mu);
    expect(result.stdout).toContain('doctor [directory]:');
    expect(result.stdout).toMatch(/^\s+--sarif\s+Print the findings as SARIF/mu);
    expect(result.stdout).not.toContain('(planned)');
  });

  it('rejects an option of another command', async () => {
    const result = await exec('apply', '--json');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("option '--json' is not supported by 'apply'");
  });

  it('shows help instead of running a command when --help is given', async () => {
    const result = await exec('doctor', '--help');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Usage: depgate');
  });

  it.each([['doctor', '--help'], ['doctor', '-h'], ['help', 'doctor']])('%s %s describes the command, its options, examples and exit codes', async (...argv) => {
    const result = await exec(...argv);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^Usage: depgate doctor \[directory\] \[options\]$/m);
    expect(result.stdout).toMatch(/^ {2}--sarif {2,}Print the findings as SARIF/m);
    expect(result.stdout).toMatch(/^ {2}-h, --help {2,}Show this help$/m);
    expect(result.stdout).toMatch(/^Examples:\n {2}depgate doctor$/m);
    expect(result.stdout).toMatch(/^ {2}1 {2}at least one finding with level error/m);
    expect(result.stdout.split('\n').every((line) => line.length <= 80)).toBe(true);
  });

  it('describes every command in its own help', async () => {
    for (const command of ['init', 'apply', 'doctor', 'explain']) {
      const result = await exec(command, '--help');
      expect(result.stdout).toMatch(new RegExp(`^Usage: depgate ${command} `, 'm'));
      expect(result.stdout).toMatch(/^Exit codes:\n {2}0 /m);
    }
  });

  it('points an unknown option of a command to that command\'s help', async () => {
    const result = await exec('apply', '--frobnicate');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe("depgate: unknown option '--frobnicate'\nRun 'depgate apply --help' for its options.\n");
  });

  it('points too many arguments to the command help', async () => {
    const result = await exec('doctor', 'a', 'b');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("Run 'depgate doctor --help' for usage.");
  });
});
