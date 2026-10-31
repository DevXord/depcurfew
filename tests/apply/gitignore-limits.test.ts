// Repository input that once took the .gitignore matcher and the index reader down: a pattern with thousands of **
// segments overflowed the stack (recursion per segment), and an index of version 4 whose entries keep a long
// previous name copied it for every entry. Both must finish quickly without an exception (decision D-079).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ignoredByGit, trackedFiles } from '../../src/apply/gitignore.ts';
import { applyProject } from '../../src/apply/index.ts';
import { Repository } from '../../src/detect/repository.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-gitignore-'));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

/** An index of version 4: a first entry with a long name, then entries that keep all of it and add nothing. */
function amplifyingIndex(nameLength: number, entries: number): Buffer {
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(4, 4);
  header.writeUInt32BE(entries, 8);
  // The flags hold the length of the whole name, or 0x0fff when it is that long or longer.
  const flags = Math.min(nameLength, 0x0fff);
  const entry = (name: Buffer) => {
    const fixed = Buffer.alloc(62);
    fixed.writeUInt16BE(flags, 60);
    // Strip nothing of the previous name (a one-byte varint 0), then the new part and its NUL.
    return Buffer.concat([fixed, Buffer.from([0]), name, Buffer.from([0])]);
  };
  const first = entry(Buffer.alloc(nameLength, 'a'));
  const rest = entry(Buffer.alloc(0));
  return Buffer.concat([header, first, ...Array.from({ length: entries - 1 }, () => rest), Buffer.alloc(20)]);
}

describe('.gitignore patterns with many segments', () => {
  const deep = `${'**/'.repeat(30000)}.npmrc\n`;

  it('match without overflowing the stack', () => {
    const root = repo({ '.gitignore': deep });
    expect(ignoredByGit(new Repository(root), '.npmrc')).toMatchObject({ ignored: true });
    expect(ignoredByGit(new Repository(root), 'package.json')).toEqual({ ignored: false });
  });

  it('do not stop apply', () => {
    const root = repo({ '.gitignore': deep, 'package.json': '{"name":"app","version":"1.0.0"}\n', 'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"}}\n' });
    const report = applyProject(root, { write: false });
    expect(report.changes.map((change) => change.file)).toEqual(['.npmrc']);
    expect(report.warningDetails.map((warning) => warning.code)).toContain('file-ignored-by-git');
  });
});

describe('the index of version 4', () => {
  it('is not read when its names add up to far more than the file holds', () => {
    const root = repo({ '.git/index': amplifyingIndex(1024 * 1024, 2000) });
    const started = Date.now();
    expect(trackedFiles(new Repository(root))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('still reads an ordinary one', () => {
    const root = repo({ '.git/index': amplifyingIndex(12, 3) });
    expect(trackedFiles(new Repository(root))).toEqual(new Set(['aaaaaaaaaaaa']));
  });
});
