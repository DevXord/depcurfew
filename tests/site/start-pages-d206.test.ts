// Decision D-206: the section of the README on a repository without package.json is on every start page of an
// ecosystem whose projects may have no package.json (Python, PHP, Ruby) and on the bots' page, which covers the
// ecosystems only the bots delay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { START_PAGES } from '../../scripts/site/build.ts';
import { slugify } from '../../scripts/site/markdown.ts';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const HEADING = 'In a repository without package.json';

describe('start pages (D-206)', () => {
  it('show the section on a repository without package.json', () => {
    expect(readme).toContain(`\n### ${HEADING}\n`);
    const id = slugify(HEADING);
    expect(id).toBe('in-a-repository-without-packagejson');
    for (const file of ['python.html', 'php.html', 'ruby.html', 'bots.html']) {
      const page = START_PAGES.find((entry) => entry.file === file);
      expect(page?.guide, file).toContain(id);
    }
  });
});
