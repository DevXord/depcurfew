// Decision D-207: the README order and the hand-written texts that were wrong. The registry keeps only the first
// 65,536 characters of the README as the readme of the package, so the Supported tools table and the links to the
// documentation site must lie inside them; the codes of init and apply follow the doctor rules instead. The lists of
// files in hand-written text name what the knowledge base and manifest-missing name, the product sentence names every
// tool of the knowledge base, no text claims a release-age delay in the project for a tool that has none there, and
// the README says which projects detection does not read while no doctor rule reports them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPLY_WARNINGS } from '../../src/apply/warnings.ts';
import { values } from '../../src/apply/facts.ts';
import { helpText } from '../../src/cli/help.ts';
import { handWritten } from '../../src/docs/readme.ts';
import { RULES } from '../../src/doctor/rules/index.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { policyJsonSchema } from '../../src/policy/json-schema.ts';
import { README_PAGES } from '../../scripts/site/build.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const text = handWritten(readme);

/** The README as the registry keeps it: its first 65,536 characters (UTF-16 units, no more than code points). */
const REGISTRY_README_LENGTH = 65_536;
const SITE = 'https://depcurfew.github.io/';

/** The level-2 and level-3 headings of the README in order. */
const headings = [...readme.matchAll(/^(#{2,3}) (.+)$/gmu)].map((match) => ({ level: (match[1] ?? '').length, text: match[2] ?? '' }));

/** The text of the hand-written list item or paragraph that starts with `start`. */
function paragraph(start: string): string {
  const index = text.indexOf(start);
  expect(index, start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n', index);
  return text.slice(index, end === -1 ? undefined : end);
}

/** The names in backticks of a text. */
const codeSpans = (value: string) => [...value.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? '');

const packageManagers = knowledgeBase.filter((tool) => tool.kind === 'package-manager');

describe('README order (D-207)', () => {
  it('keeps the Supported tools table and the links to the documentation site in the part the registry keeps', () => {
    const kept = readme.slice(0, REGISTRY_README_LENGTH);
    expect(kept).toContain('<!-- END GENERATED: tools -->');
    expect(kept).toContain(`](${SITE}`);
  });

  it('links to pages the site builds, from a short list near the top', () => {
    const top = readme.slice(0, readme.indexOf('\n## Installation\n'));
    const links = [...top.matchAll(/\]\(https:\/\/depcurfew\.github\.io\/([^)#]*)\)/gu)].map((match) => match[1] ?? '');
    const pages = links.filter((file) => file !== '');
    expect(pages.length).toBeGreaterThanOrEqual(5);
    const built = new Set([...README_PAGES.map((page) => page.file), 'knowledge.html']);
    for (const file of pages) expect(built.has(file), file).toBe(true);
  });

  it('puts the codes of init and apply under a section of their own after the doctor rules, with their anchors', () => {
    const at = (heading: string) => headings.findIndex((entry) => entry.text === heading);
    const codes = at('Warnings and errors of init and apply');
    expect(headings[codes]?.level).toBe(2);
    expect(codes).toBeGreaterThan(at('doctor rules'));
    expect(codes).toBeGreaterThan(at('Supported tools'));
    expect(headings[codes + 1]).toEqual({ level: 3, text: 'init warnings and notes' });
    expect(headings[codes + 2]).toEqual({ level: 3, text: 'apply warnings and errors' });
    const codesPage = README_PAGES.find((page) => page.file === 'codes.html');
    expect(codesPage?.sections).toEqual(['warnings-and-errors-of-init-and-apply']);
  });
});

describe('hand-written lists (D-207)', () => {
  it('names every manifest of manifest-missing among the manifests apply does not create', () => {
    const named = /\(([^)]+)\)/u.exec(APPLY_WARNINGS['manifest-missing'])?.[1]?.split(', ') ?? [];
    expect(named).toEqual(expect.arrayContaining(['package.json', 'composer.json', 'Gemfile']));
    const sentence = codeSpans(paragraph('- It does not create bot configuration files, project manifests'));
    for (const file of named) expect(sentence, file).toContain(file);
  });

  it('names every file apply writes for a package manager in the bullet for developers', () => {
    const bullet = codeSpans(paragraph('- **Developers working on the project:**'));
    const files = new Set<string>();
    for (const tool of packageManagers) {
      // Cargo is detected since E06, and apply writes .cargo/config.toml from E07 on, which adds it to the bullet.
      if (tool.id === 'cargo') continue;
      for (const entry of values(tool.cooldown.configFiles)) for (const file of entry) files.add(file);
      const allowList = tool.installScripts.allowList.file;
      if (allowList !== undefined) for (const file of values(allowList)) if (file !== null) files.add(file);
    }
    expect([...files]).toEqual(expect.arrayContaining(['.npmrc', 'composer.json', 'Gemfile', 'gems.rb']));
    for (const file of files) expect(bullet, file).toContain(file);
  });

  it('claims a release-age delay only for the package managers depcurfew configures, pip through its environment', () => {
    const bullet = paragraph('- **Versions that are too new.**');
    expect(bullet).not.toMatch(/Every package manager and update bot in the repository/u);
    expect(bullet).toContain('Every package manager depcurfew configures');
    expect(bullet).toContain('pip');
    expect(bullet).toContain('(#update-bots)');
  });
});

describe('the product sentence (D-207)', () => {
  // The names of the knowledge base without a note in parentheses: "Yarn (Berry)" is Yarn.
  const names = knowledgeBase.map((tool) => tool.name.replace(/\s*\([^)]*\)$/u, ''));

  it.each([
    ['depcurfew --help', helpText().split('\n').find((line) => line.startsWith('One supply-chain security policy')) ?? ''],
    ['schema.json', String(policyJsonSchema().description ?? '')],
    ['README.md', readme.split('\n').find((line) => line.startsWith('> One supply-chain security policy')) ?? ''],
  ])('names every tool of the knowledge base in %s', (_where, sentence) => {
    expect(sentence).not.toBe('');
    for (const name of names) expect(sentence, name).toMatch(new RegExp(`(^|[ ,])${name}([ ,.]|$)`, 'u'));
  });
});

describe('the limits of detection (D-207)', () => {
  const LIMITATION = 'a project elsewhere, for example `frontend/` beside a uv project in the root, is not configured or checked until it is listed in `projects`';

  it('says which projects detection does not read while no doctor rule reports them', () => {
    const reported = RULES.some((rule) => /project/u.test(rule.id) && /not-covered|uncovered|not-listed|unlisted/u.test(rule.id));
    expect(text.includes(LIMITATION)).toBe(!reported);
  });
});
