// Every action used by action.yml and by this repository's workflows is pinned to a full commit SHA, with the
// version it stands for in a comment, so a moved tag cannot change what runs.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const files = [
  'action.yml',
  ...readdirSync(new URL('.github/workflows/', ROOT))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => `.github/workflows/${name}`),
];

describe('pinned actions', () => {
  it('finds the workflows', () => {
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.github/workflows/action-test.yml');
  });

  it.each(files)('%s pins every action to a commit SHA', (file) => {
    const lines = readFileSync(fileURLToPath(new URL(file, ROOT)), 'utf8').split('\n');
    const uses = lines.filter((line) => /^\s*(-\s+)?uses:/u.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const value = /uses:\s*(\S+)/u.exec(line)?.[1] ?? '';
      if (value.startsWith('./')) continue;
      expect(line, `${file}: ${line.trim()}`).toMatch(/uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/u);
    }
  });

  it('uses the same version of an action everywhere', () => {
    const pins = new Map<string, Set<string>>();
    for (const file of files) {
      for (const match of readFileSync(fileURLToPath(new URL(file, ROOT)), 'utf8').matchAll(/uses:\s*([\w.-]+\/[\w.-]+)[\w./-]*@([0-9a-f]{40})/gu)) {
        const [, action = '', sha = ''] = match;
        pins.set(action, new Set([...(pins.get(action) ?? []), sha]));
      }
    }
    for (const [action, shas] of pins) expect(shas.size, action).toBe(1);
  });
});
