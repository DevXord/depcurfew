// Decision D-207: the summary of tools.html, also its description for search engines, names every section of
// "Supported tools" in the README, and codes.html takes the codes of init and apply from the section of the README
// that holds them, after the doctor rules.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { README_PAGES } from '../../scripts/site/build.ts';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

/** The level-3 headings of a level-2 section of the README. */
function subsections(title: string): string[] {
  const start = readme.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 1);
  const body = readme.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/^### (.+)$/gmu)].map((match) => match[1] ?? '');
}

describe('site summaries (D-207)', () => {
  it('names every section of Supported tools in the summary of tools.html', () => {
    const summary = README_PAGES.find((page) => page.file === 'tools.html')?.summary ?? '';
    const sections = subsections('Supported tools');
    expect(sections).toEqual(expect.arrayContaining(['Python projects', 'Update bots', 'Composer projects', 'Ruby projects']));
    for (const section of sections) expect(summary.toLowerCase(), section).toContain(section.toLowerCase());
  });
});
