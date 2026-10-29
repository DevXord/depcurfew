import { describe, expect, it } from 'vitest';
import { annotationCommands, jobSummary, RULES } from '../../src/doctor/index.ts';
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
      '::error file=a%2Cb%3Ac%0A%3A%3Awarning%3A%3Ax%250A,line=3,title=depgate%3A config-drift::line one%0A::error::injected%0AFix: 100%25 sure%0D%0Anext',
    ]);
    expect(lines.join('\n').split('\n')).toHaveLength(1);
  });

  it('use notice for notes and leave out the line when there is none', () => {
    const note: Finding = { rule: 'broad-exclusion', level: 'note', location: { file: 'depgate.json' }, message: 'm' };
    expect(annotationCommands(report([note]), RULES).lines[0]).toMatch(/^::notice file=depgate\.json,title=depgate%3A broad-exclusion::m/u);
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
    expect(jobSummary(report([]), RULES, '', 1024 * 1024)).toBe('## depgate doctor\n\nNo problems found.\n');
  });

  it('leaves out rows that would make it too long and says how many', () => {
    const findings = Array.from({ length: 50 }, (_, index) => finding('warning', `file-${index}`, 'x'.repeat(100)));
    const text = jobSummary(report(findings), RULES, '', 4096);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/\n\d+ more findings did not fit in the summary; the step log lists every finding\.\n$/u);
  });
});
