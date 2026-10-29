// depgate applies its own policy: depgate.json is valid, apply has nothing to change and doctor finds no error.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('depgate on itself', () => {
  it('has applied its policy', () => {
    const report = applyProject(ROOT, { write: false });
    expect(report.errors).toEqual([]);
    expect(report.changes).toEqual([]);
  });

  it('passes its own doctor', () => {
    const report = runDoctor(ROOT);
    expect(report.policy).toBe('valid');
    expect(report.findings.filter((finding) => finding.level === 'error')).toEqual([]);
  });
});
