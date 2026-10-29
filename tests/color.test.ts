import { describe, expect, it } from 'vitest';
import { COLORED, colorsFor, paintDiagnostics, PLAIN } from '../src/color.ts';
import { run, type CliIo } from '../src/cli/run.ts';
import { renderText, RULES } from '../src/doctor/index.ts';
import type { DoctorReport } from '../src/doctor/types.ts';

const ANSI = /\u001b\[/u;

async function exec(colors: CliIo['colors'], ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(colors === undefined ? {} : { colors }),
  });
  return { code, stdout, stderr };
}

describe('colorsFor', () => {
  it.each([
    [true, {}, true],
    [false, {}, false],
    [true, { TERM: 'dumb' }, false],
    [true, { NO_COLOR: '1' }, false],
    [true, { NO_COLOR: '' }, true],
    [false, { FORCE_COLOR: '1' }, true],
    [false, { FORCE_COLOR: '' }, true],
    [true, { FORCE_COLOR: '0' }, false],
    [true, { FORCE_COLOR: 'false' }, false],
    [false, { FORCE_COLOR: '1', NO_COLOR: '1' }, true],
  ])('a terminal: %s, environment %j: %s', (isTTY, env, expected) => {
    expect(colorsFor({ isTTY }, env)).toBe(expected);
  });
});

describe('colored output', () => {
  const report: DoctorReport = {
    schemaVersion: 1,
    policy: 'valid',
    findings: [
      { rule: 'config-drift', level: 'error', location: { file: '.npmrc', line: 2 }, message: 'drift', fix: 'Run depgate apply' },
      { rule: 'broad-exclusion', level: 'warning', location: { file: 'depgate.json' }, message: 'broad' },
    ],
    notices: [{ message: 'a notice' }],
  };

  it('prints the same words with and without colors', () => {
    const colored = renderText(report, RULES, COLORED);
    expect(colored).toMatch(ANSI);
    expect(colored.replace(/\u001b\[\d+m/gu, '')).toBe(renderText(report, RULES, PLAIN));
    expect(renderText(report, RULES)).not.toMatch(ANSI);
  });

  it('marks the level, the file, the rule and the fix', () => {
    const colored = renderText(report, RULES, COLORED);
    expect(colored).toContain('\u001b[1m\u001b[31merror\u001b[39m\u001b[22m drift');
    expect(colored).toContain('\u001b[33mwarning\u001b[39m broad');
    expect(colored).toContain('\u001b[1m.npmrc\u001b[22m');
    expect(colored).toContain('\u001b[2m(config-drift)\u001b[22m');
    expect(colored).toContain('\u001b[32mfix:\u001b[39m Run depgate apply');
  });

  it('colors the prefix of diagnostics only', () => {
    expect(paintDiagnostics("depgate: no\nRun 'depgate --help'\nwarning: w\nerror: e\n", COLORED)).toBe(
      "\u001b[31m\u001b[1mdepgate:\u001b[22m\u001b[39m no\nRun 'depgate --help'\n\u001b[33mwarning:\u001b[39m w\n\u001b[31m\u001b[1merror:\u001b[22m\u001b[39m e\n",
    );
    expect(paintDiagnostics('depgate: no\n', PLAIN)).toBe('depgate: no\n');
    expect(paintDiagnostics('note: n\n', COLORED)).toBe('\u001b[36mnote:\u001b[39m n\n');
  });

  it('colors each stream only when that stream allows it', async () => {
    const toPipe = await exec({ stdout: false, stderr: true }, 'frobnicate');
    expect(toPipe.stderr).toMatch(/^\u001b\[31m/u);
    const help = await exec({ stdout: false, stderr: true }, '--help');
    expect(help.stdout).not.toMatch(ANSI);
    const coloredHelp = await exec({ stdout: true, stderr: false }, 'doctor', '--help');
    expect(coloredHelp.stdout).toContain('\u001b[1mExit codes:\u001b[22m');
    expect(coloredHelp.stdout.replace(/\u001b\[\d+m/gu, '')).toBe((await exec(undefined, 'doctor', '--help')).stdout);
  });
});
