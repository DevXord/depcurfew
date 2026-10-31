// Detection orders files by their bytes, not by the locale: the first version declaration in that order is the pinned
// version apply and doctor use, so the order must not depend on the machine (Turkish, Swedish or German collation).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const workflow = (version: string) => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: pnpm/action-setup@v4\n        with:\n          version: ${version}\n`;

describe('detection order', () => {
  it('orders version declarations from several files by bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-byte-order-'));
    temporary.push(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ "name": "x" }');
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    // "Z" (0x5A) comes before "a" (0x61) in bytes; localeCompare puts "a" first.
    writeFileSync(join(root, '.github', 'workflows', 'a.yml'), workflow('10.0.0'));
    writeFileSync(join(root, '.github', 'workflows', 'Z.yml'), workflow('11.0.0'));
    const pnpm = detectProject(root).packageManagers.find((manager) => manager.id === 'pnpm');
    expect(pnpm?.versions.map((declaration) => declaration.file)).toEqual(['.github/workflows/Z.yml', '.github/workflows/a.yml']);
  });
});
