// The internal documents of the maintainer (the plan, the decision log and the log of the work, decision D-180 in the
// decision log) live outside the repository: git does not track them, .gitignore lists them as a safeguard, and no
// public Markdown file names or links to them. CLAUDE.md, the instructions for coding agents, names them without a
// path, and the tests may name them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INTERNAL = ['docs/PLAN.md', 'docs/decisions.md', 'docs/CHANGELOG-dev.md'] as const;

/** A path to one of them or a relative link to it, with or without docs/, ./ or ../ in front, also inside a URL. */
export const INTERNAL_REFERENCE = /(?<![\w.-])(?:\.{1,2}\/)*(?:docs\/)?(?:PLAN|decisions|CHANGELOG-dev)\.md(?![\w-])/u;

const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => path !== '');

describe('internal documents of the maintainer', () => {
  it('are not tracked by git', () => {
    const files = tracked();
    expect(files.length).toBeGreaterThan(0);
    for (const path of INTERNAL) expect(files, path).not.toContain(path);
  });

  it('are listed in .gitignore as a safeguard', () => {
    const lines = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^\//u, ''));
    for (const path of INTERNAL) expect(lines, path).toContain(path);
  });

  it('are named or linked by no tracked Markdown file but CLAUDE.md and the tests', () => {
    const markdown = tracked().filter((path) => /\.(md|markdown)$/iu.test(path) && path !== 'CLAUDE.md' && !path.startsWith('tests/'));
    expect(markdown).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/RELEASING.md']));
    const found = markdown.flatMap((path) =>
      readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
        .split('\n')
        .flatMap((line, index) => (INTERNAL_REFERENCE.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it.each([
    'docs/decisions.md',
    'justified in `decisions.md`',
    'see [the plan](../docs/PLAN.md#x)',
    'the [log](./CHANGELOG-dev.md)',
    'https://github.com/DevXord/depcurfew/blob/main/docs/decisions.md',
    '(docs/CHANGELOG-dev.md)',
  ])('finds the reference in %j', (text) => {
    expect(INTERNAL_REFERENCE.test(text)).toBe(true);
  });

  it.each(['CHANGELOG.md', 'docs/RELEASING.md', 'docs/knowledge.md', 'src/doctor/plan.ts', 'XPLAN.md', 'my-decisions.md', 'decision D-099', 'the plan of apply', 'PLAN.mdx'])(
    'finds no reference in the public %j',
    (text) => {
      expect(INTERNAL_REFERENCE.test(text)).toBe(false);
    },
  );
});
