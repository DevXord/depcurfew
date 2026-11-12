// Decision D-206: the fix of depcurfew-outdated for the tools directory installs the copy with npm ci --prefix and runs
// it by path from the repository root. The earlier `cd .claude/depcurfew && npm ci …` left the shell in the tools
// directory, so the relative path of the next command no longer existed, and `&&` is not a command separator in Windows
// PowerShell 5.1. The fix is the same in the text, JSON and SARIF output of doctor.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';

const REPO = join(fileURLToPath(new URL('../fixtures/doctor/depcurfew-outdated/fires-tools-directory/', import.meta.url)), 'repo');
const FIX =
  'Install it in .claude/depcurfew (npm ci --ignore-scripts --prefix .claude/depcurfew), then run that copy (node .claude/depcurfew/node_modules/depcurfew/dist/cli.js doctor), or update the depcurfew you run to 99.0.0 or later';

async function doctor(format: string[]): Promise<string> {
  let stdout = '';
  await run(['doctor', ...format, REPO], { stdout: (text) => (stdout += text), stderr: () => undefined });
  return stdout;
}

describe('depcurfew-outdated fix for the tools directory (D-206)', () => {
  it('is the same in text, JSON and SARIF, without cd', async () => {
    const text = await doctor([]);
    expect(text.replace(/\s+/gu, ' ')).toContain(FIX);
    const json = JSON.parse(await doctor(['--json'])) as { findings: { rule: string; fix?: string }[] };
    expect(json.findings.filter((finding) => finding.rule === 'depcurfew-outdated').map((finding) => finding.fix)).toEqual([FIX]);
    const sarif = await doctor(['--sarif']);
    expect(sarif).toContain(FIX);
    for (const output of [text, JSON.stringify(json), sarif]) expect(output).not.toContain('cd .claude/depcurfew');
  });
});
