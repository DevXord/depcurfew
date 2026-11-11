// Decision D-207: the warning nothing-detected names the manifests of every package manager of the knowledge base,
// so that a Composer or Ruby repository is not told that depcurfew looks only for JavaScript and Python files.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { detectProject } from '../../src/detect/index.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('nothing-detected (D-207)', () => {
  it('names every manifest of the knowledge base and lockfiles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d207-'));
    directories.push(directory);
    const warning = detectProject(directory).warnings.find((entry) => entry.code === 'nothing-detected');
    expect(warning).toBeDefined();
    const manifests = [...new Set(knowledgeBase.flatMap((tool) => (tool.project === undefined ? [] : values(tool.project.manifests).flat())))];
    expect(manifests).toEqual(expect.arrayContaining(['package.json', 'composer.json', 'Gemfile', 'gems.rb', 'Pipfile']));
    for (const file of manifests) expect(warning?.message, file).toMatch(new RegExp(`(^|[ ,])${file.replaceAll('.', '\\.')}([ ,]|$)`, 'u'));
    expect(warning?.message).toMatch(/ or lockfile found$/u);
  });
});
