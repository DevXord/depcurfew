// unreadable-config with inputs whose parser messages differ between Node versions (JSON.parse), so they are not in
// the fixtures: an invalid package.json fails doctor instead of passing silently.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('unreadable-config', () => {
  it('reports an invalid package.json as an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'depgate-unreadable-'));
    temporary.push(root);
    writeFileSync(join(root, 'package.json'), '{"name": "app", "packageManager": "npm@11.19.1",}\n');
    const findings = runDoctor(root).findings.filter((finding) => finding.rule === 'unreadable-config');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'error', location: { file: 'package.json' } });
    expect(findings[0]?.message).toMatch(/^cannot parse package\.json: .+; depgate cannot check it$/u);
  });

  it('is not repeated as a notice', () => {
    const root = mkdtempSync(join(tmpdir(), 'depgate-unreadable-'));
    temporary.push(root);
    writeFileSync(join(root, 'package.json'), '{"name": "app",\n');
    expect(runDoctor(root).notices.some((notice) => notice.message.includes('cannot parse package.json'))).toBe(false);
  });
});
