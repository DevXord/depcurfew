// A usage error with --json (D-107): stdout holds the JSON document with the error (code usage, message and fix), as for
// other errors that keep a command from starting, stderr stays empty and the exit code is 2. Without --json the text
// on stderr has the same form as those errors (D-113).
import { describe, expect, it } from 'vitest';
import { EXIT_USAGE, run } from '../../src/cli/run.ts';

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

describe('usage errors with --json', () => {
  it.each([
    [['doctor', '--json', '--jsn'], "unknown option '--jsn'", "Run 'depcurfew doctor --help' for its options"],
    [['check', '--json'], "'check' needs at least one package, e.g. depcurfew check lodash@4", "Run 'depcurfew check --help' for usage"],
    [['doctor', '--json', '--sarif'], "'--json' and '--sarif' cannot be used together; pick one", "Run 'depcurfew doctor --help' for usage"],
    [['apply', '--json', 'a', 'b'], "too many arguments for 'apply'", "Run 'depcurfew apply --help' for usage"],
    [['explain', '--json', '--dry-run'], "option '--dry-run' is not supported by 'explain'", "Run 'depcurfew explain --help' for its options"],
    [['apply', '--json', '--for', 'npm@11.19.1'], '--for works only with --user', "Run 'depcurfew apply --help' for usage"],
  ])('%j prints the error as JSON on stdout', async (argv, message, fix) => {
    const result = await exec(...argv);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, errors: [{ code: 'usage', level: 'error', message, fix }] });
  });

  it('keeps the text on stderr without --json', async () => {
    const result = await exec('check');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toBe('');
    // The text form of every error that keeps a command from starting (decision D-113).
    expect(result.stderr).toBe("error: 'check' needs at least one package, e.g. depcurfew check lodash@4 (usage)\n  fix: Run 'depcurfew check --help' for usage\n");
  });
});
