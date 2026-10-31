import { describe, expect, it } from 'vitest';
import { annotationCommands, cleanNotice, jobSummary, RULES } from '../../src/doctor/index.ts';
import { markdown } from '../../src/doctor/github.ts';
import type { DoctorReport, Finding } from '../../src/doctor/types.ts';

function finding(level: Finding['level'], file: string, message = 'message', fix = 'fix it'): Finding {
  return { rule: 'config-drift', level, location: { file, line: 3 }, message, fix };
}

function report(findings: Finding[]): DoctorReport {
  return { schemaVersion: 1, policy: 'valid', findings, notices: [] };
}

describe('annotations', () => {
  it('escape text from the repository so it cannot start another workflow command', () => {
    const crafted = finding('error', 'a,b:c\n::warning::x%0A', 'line one\n::error::injected', '100% sure\r\nnext');
    const { lines } = annotationCommands(report([crafted]), RULES);
    expect(lines).toEqual([
      // Line breaks in the crafted text are shown as text, as in the log; the one before the fix is depcurfew's.
      '::error file=a%2Cb%3Ac\\x0a%3A%3Awarning%3A%3Ax%250A,line=3,title=depcurfew%3A config-drift::line one\\x0a::error::injected%0AFix: 100%25 sure\\x0d\\x0anext',
    ]);
    expect(lines.join('\n').split('\n')).toHaveLength(1);
  });

  it('use notice for notes and leave out the line when there is none', () => {
    const note: Finding = { rule: 'broad-exclusion', level: 'note', location: { file: 'depcurfew.json' }, message: 'm' };
    expect(annotationCommands(report([note]), RULES).lines[0]).toMatch(/^::notice file=depcurfew\.json,title=depcurfew%3A broad-exclusion::m/u);
  });

  it('stay within the number GitHub shows per step, errors first', () => {
    const findings = [
      ...Array.from({ length: 12 }, (_, index) => finding('warning', `w${index}`)),
      ...Array.from({ length: 15 }, (_, index) => finding('error', `e${index}`)),
    ];
    const { lines, omitted } = annotationCommands(report(findings), RULES, undefined, { perLevelPerStep: 10, perJob: 15 });
    expect(lines.filter((line) => line.startsWith('::error '))).toHaveLength(10);
    expect(lines.filter((line) => line.startsWith('::warning '))).toHaveLength(5);
    expect(omitted).toBe(12);
    expect(lines[0]).toContain('file=e0,');
  });
});

describe('job summary', () => {
  it('escapes Markdown outside code spans and pipes inside them', () => {
    expect(markdown('a | b <img src=x> *c* [d](e) `x | <y>` https://evil.example')).toBe(
      'a \\| b &lt;img src=x&gt; \\*c\\* \\[d\\](e) `x \\| <y>` https&#8203;://evil.example',
    );
    expect(markdown('one\ntwo')).toBe('one two');
  });

  it('says when there is nothing to fix', () => {
    expect(jobSummary(report([]), RULES, '', 1024 * 1024)).toBe('## depcurfew doctor\n\n**No problems found**.\n');
  });

  it('leaves out rows that would make it too long and says how many', () => {
    const findings = Array.from({ length: 50 }, (_, index) => finding('warning', `file-${index}`, 'x'.repeat(100)));
    const text = jobSummary(report(findings), RULES, '', 4096);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/\n\d+ more findings did not fit in the summary; the step log lists every finding\.\n$/u);
  });
});

describe('what was checked', () => {
  const result = (rule: string, check: string, kind: 'passed' | 'problems' | 'skipped', errors = 0) => ({ rule, check, result: kind, errors, warnings: 0, notes: 0 });
  const checked = {
    tools: [{ id: 'npm', name: 'npm', version: '11.21.1', versionFrom: 'package.json' }, { id: 'renovate', name: 'Renovate' }],
    files: ['package.json', 'renovate.json'],
    rules: [result('config-drift', 'Configuration files match', 'passed'), result('bot-cooldown-mismatch', 'Bots wait as long', 'skipped')],
    policyFile: 'depcurfew.json',
  };

  it('lists the tools, the files read and every check with its result in the job summary', () => {
    const summary = jobSummary({ ...report([]), checked }, RULES, '', 1024 * 1024);
    expect(summary).toContain('**No problems found**.');
    expect(summary).toContain('### What was checked\n\n- Tools: npm 11.21.1 (package.json), Renovate\n- Files read: `package.json`, `renovate.json`\n- 2 checks: 1 passed, 1 skipped\n');
    expect(summary).toContain('| Result | Check | Rule |\n| --- | --- | --- |\n| passed | Configuration files match | `config-drift` |\n| skipped (needs `depcurfew.json`) | Bots wait as long | `bot-cooldown-mismatch` |');
  });

  it('shows the counts of a check that found problems', () => {
    const failing = { ...checked, rules: [result('config-drift', 'Configuration files match', 'problems', 2)] };
    const finding = { rule: 'config-drift', level: 'error' as const, message: 'x', location: { file: 'a' } };
    expect(jobSummary({ ...report([finding, finding]), checked: failing }, RULES, '', 1024 * 1024)).toContain('| **2 errors** | Configuration files match | `config-drift` |');
  });

  it('adds a notice for a clean report with every check, so the run shows what doctor checked', () => {
    expect(cleanNotice({ ...report([]), checked })).toBe(
      '::notice title=depcurfew doctor%3A no problems found::No problems found in 2 files for npm 11.21.1 (package.json), Renovate. 2 checks: 1 passed, 1 skipped.%0Apassed: Configuration files match%0Askipped: Bots wait as long (needs depcurfew.json)',
    );
    expect(cleanNotice(report([{ rule: 'config-drift', level: 'warning', message: 'x', location: { file: 'a' } }]))).toBeUndefined();
  });

  it('escapes the notice so a file name cannot start another workflow command', () => {
    const line = cleanNotice({ ...report([]), checked: { ...checked, tools: [{ id: 'npm', name: 'npm', version: '1%0A::error::x', versionFrom: 'a\nb' }] } });
    expect(line?.split('\n')).toHaveLength(1);
    expect(line).not.toContain('\n::error');
  });
});
