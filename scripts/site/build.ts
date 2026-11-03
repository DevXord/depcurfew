// The documentation site (decision D-132), built from the sources of README.md so that it cannot drift from it:
// README.md with its generated sections rendered afresh, the knowledge base as docs/knowledge.md shows it, and
// schema.json. Every page is the README text of its sections, the knowledge base, or a start page for one ecosystem
// that puts README sections and the README tables of its tools together. Hand-written text is limited to
// navigation. Links are relative, so the site works at the root of a domain (https://depcurfew.github.io/, decision
// D-139) and under a path; the only things loaded are its own stylesheet and icon. With earlier versions (D-139) the
// site also has a Versions page and a directory /<version>/ for each earlier release. The design (D-140): the pages in
// groups of the navigation (PAGE_GROUPS), a hero on the start page, an "On this page" list on long pages and the
// levels of doctor rules and codes as pills, all without JavaScript.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { KNOWLEDGE_DOCUMENT, readmeSections, renderReadme, type ReadmeInputs } from '../../src/docs/readme.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { evidenceOf } from '../../src/knowledge/facts.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../../src/knowledge/render.ts';
import type { Ecosystem, ToolId, ToolKnowledge } from '../../src/knowledge/types.ts';
import { createSlugger, escapeHtml, renderMarkdown, slugify, splitSections, type Section } from './markdown.ts';
import { FIRST_ARCHIVED_VERSION, repositoryUrl, type ArchivedVersion } from './versions.ts';

const REPOSITORY = new URL('../../', import.meta.url);

interface Page {
  file: string;
  /** The link text in the navigation. */
  nav: string;
  /** The page title, and the h1 of a page with a heading of its own. */
  title: string;
  /** One line for the list of pages on the start page. */
  summary: string;
}

export interface ReadmePage extends Page {
  /** README sections on this page, by their GitHub id; each brings the sections under it that no other page names. */
  sections: readonly string[];
  /** The title as a heading above the README sections, which then start at level 2; otherwise the first section is the h1. */
  heading?: boolean;
  /** Takes the README sections that no page names, so that a new section is never left out. */
  rest?: boolean;
  /** Markdown after the README sections. */
  extra?: string;
  /** Ends with the list of the other pages of the site. */
  contents?: boolean;
  /** Shows its first README section, the title of the README with its introduction, as the hero (D-140). */
  hero?: boolean;
}

export interface StartPage extends Page {
  tools: readonly ToolId[];
  /** README sections shown after the five-minute start. */
  guide: readonly string[];
  /** README sections of doctor rules about these tools. */
  rules: readonly string[];
}

const SCHEMA = [
  '## JSON Schema',
  '',
  '[`schema.json`](schema.json) is the JSON Schema of `depcurfew.json`, the file the npm package ships. [`schema/v1.json`](schema/v1.json) is the same file at an address that stays with version 1 of the policy format.',
].join('\n');

export const README_PAGES: readonly ReadmePage[] = [
  {
    file: 'index.html',
    nav: 'Overview',
    title: 'depcurfew',
    summary: 'What depcurfew does, the five-minute start and the installation.',
    sections: ['depcurfew', 'why', 'five-minute-start', 'installation'],
    contents: true,
    hero: true,
  },
  {
    file: 'policy.html',
    nav: 'Policy',
    title: 'The policy file',
    summary: 'Every field of depcurfew.json, several projects in one repository, and the JSON Schema.',
    sections: ['the-policy-file'],
    extra: SCHEMA,
  },
  { file: 'commands.html', nav: 'Commands', title: 'Commands', summary: 'Every command with its options, exit codes and JSON output.', sections: ['commands'] },
  {
    file: 'codes.html',
    nav: 'Codes',
    title: 'Warnings and errors of init and apply',
    summary: 'Every code of the warnings, notes and errors of init and apply.',
    sections: ['init-warnings-and-notes', 'apply-warnings-and-errors'],
    heading: true,
  },
  { file: 'doctor.html', nav: 'doctor rules', title: 'doctor rules', summary: 'Every rule of depcurfew doctor with its level and fix.', sections: ['doctor-rules'] },
  {
    file: 'machine.html',
    nav: 'Whole machine',
    title: 'Protecting the whole machine',
    summary: 'The user policy, the user file of each tool and the doctor --user rules.',
    sections: ['protecting-the-whole-machine'],
  },
  { file: 'tools.html', nav: 'Tools', title: 'Supported tools', summary: 'What depcurfew configures and checks for each tool, and Python projects.', sections: ['supported-tools'] },
  { file: 'action.html', nav: 'GitHub Action', title: 'GitHub Action', summary: 'The action with its inputs and outputs, and other CI systems.', sections: ['github-action'] },
  { file: 'check.html', nav: 'Guarding installs', title: 'Guarding installs', summary: 'depcurfew check before a package is installed.', sections: ['guarding-installs'] },
  { file: 'claude-code.html', nav: 'Claude Code', title: 'Claude Code', summary: 'The Claude Code hook and how to set it up.', sections: ['claude-code'] },
  { file: 'mcp.html', nav: 'MCP server', title: 'MCP server', summary: 'depcurfew mcp and how to add it to an MCP client.', sections: ['mcp-server'] },
  { file: 'guide.html', nav: 'Step-by-step guide', title: 'Step-by-step guide', summary: 'From the first doctor run to CI, coding agents and the whole machine, one step at a time.', sections: ['step-by-step-guide'] },
  { file: 'other-tools.html', nav: 'Other tools', title: 'Alongside other supply-chain tools', summary: 'How depcurfew works together with tools that inspect the packages themselves.', sections: ['alongside-other-supply-chain-tools'] },
  {
    file: 'about.html',
    nav: 'About',
    title: 'About depcurfew',
    summary: 'What depcurfew does not do, network and privacy, the library, contributing and the license.',
    sections: ['what-depcurfew-does-not-do', 'network-and-privacy', 'library', 'contributing', 'license', 'trademarks'],
    heading: true,
    rest: true,
  },
];

const KNOWLEDGE_PAGE: Page = { file: 'knowledge.html', nav: 'Knowledge base', title: 'Knowledge base', summary: 'Every fact depcurfew relies on, with its official source.' };

type EcosystemPage = Pick<StartPage, 'file' | 'nav' | 'guide' | 'rules'>;

/** The start page of each ecosystem of package managers; an ecosystem without an entry gets a page of its own name. */
const ECOSYSTEM_PAGES: Partial<Record<Ecosystem, EcosystemPage>> = {
  npm: { file: 'npm.html', nav: 'JavaScript', guide: [], rules: ['npmrc-overrides-policy', 'pnpm-shared-workspace-lockfile', 'pnpm-config-unverifiable'] },
  pypi: { file: 'python.html', nav: 'Python', guide: ['python-projects'], rules: ['python-config-ignored', 'lockfile-out-of-date'] },
  packagist: { file: 'php.html', nav: 'PHP', guide: ['composer-projects'], rules: ['composer-config-weakens'] },
  rubygems: { file: 'ruby.html', nav: 'Ruby', guide: ['ruby-projects'], rules: ['bundler-config-weakens'] },
};
// The bots' section of the README says what they do for each ecosystem, also for those only they delay (D-151).
const BOTS_PAGE: EcosystemPage = { file: 'bots.html', nav: 'Bots', guide: ['update-bots'], rules: ['bot-cooldown-mismatch'] };

/** The ecosystems updated by bots only, for the summary of the bots' start page: "Cargo, Go modules … and NuGet". */
const BOT_ECOSYSTEMS = Object.values(environment.botOnlyEcosystems).flatMap((entry) => evidenceOf(entry.project).slice(0, 1).map((evidence) => evidence.value.name));

const names = (tools: readonly ToolKnowledge[]) => {
  const all = tools.map((tool) => tool.name);
  return all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1) ?? ''}`;
};

function startPages(tools: readonly ToolKnowledge[]): StartPage[] {
  const groups = new Map<string, ToolKnowledge[]>();
  for (const tool of tools) {
    const key = tool.kind === 'update-bot' ? 'bots' : (tool.ecosystem ?? 'npm');
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  // Package managers first, in the order of the knowledge base, then the bots.
  const keys = [...groups.keys()].filter((key) => key !== 'bots');
  if (groups.has('bots')) keys.push('bots');
  return keys.map((key) => {
    const members = groups.get(key) ?? [];
    const page = key === 'bots' ? BOTS_PAGE : (ECOSYSTEM_PAGES[key as Ecosystem] ?? { file: `${key}.html`, nav: names(members), guide: [], rules: [] });
    const also = key === 'bots' && BOT_ECOSYSTEMS.length > 0 ? `, also for ${BOT_ECOSYSTEMS.slice(0, -1).join(', ')} and ${BOT_ECOSYSTEMS.at(-1) ?? ''}, which only the bots delay` : '';
    return {
      ...page,
      title: `Start with ${names(members)}`,
      summary: `The five-minute start, the settings and the doctor rules for ${names(members)}${also}.`,
      tools: members.map((tool) => tool.id),
    };
  });
}

export const START_PAGES: readonly StartPage[] = startPages(knowledgeBase);

/** A group of the navigation (D-140): its title and the files of its pages, in the order of the navigation. */
export interface PageGroup {
  title: string;
  files: readonly string[];
}

/**
 * The group of every page of the current version, in one place (D-140). The navigation, the order of SITE_PAGES and the
 * list of pages on the start page follow it, and a page that is in no group stops the build: a new ecosystem in the
 * knowledge base gets a start page `<ecosystem>.html`, which has to be added here.
 */
export const PAGE_GROUPS: readonly PageGroup[] = [
  { title: 'Start', files: ['index.html', 'guide.html', 'npm.html', 'python.html', 'php.html', 'ruby.html', 'bots.html'] },
  { title: 'Reference', files: ['policy.html', 'commands.html', 'codes.html', 'doctor.html', 'tools.html', 'knowledge.html'] },
  { title: 'Integrations', files: ['action.html', 'check.html', 'claude-code.html', 'mcp.html', 'machine.html'] },
  { title: 'Project', files: ['about.html', 'other-tools.html', 'versions.html'] },
];

/** The pages in their groups, in the order of PAGE_GROUPS, without empty groups; a page in no group stops the build. */
export function groupPages(pages: readonly Page[], groups: readonly PageGroup[] = PAGE_GROUPS): { title: string; pages: Page[] }[] {
  for (const page of pages) {
    const found = groups.filter((group) => group.files.includes(page.file));
    if (found.length === 0) throw new Error(`site: ${page.file} has no group in PAGE_GROUPS in scripts/site/build.ts`);
    if (found.length > 1) throw new Error(`site: ${page.file} is in more than one group of PAGE_GROUPS in scripts/site/build.ts`);
  }
  return groups
    .map((group) => ({ title: group.title, pages: group.files.flatMap((file) => pages.filter((page) => page.file === file)) }))
    .filter((group) => group.pages.length > 0);
}

/** Every page of the current version without the Versions page, in the order of the navigation. */
export const SITE_PAGES: readonly Page[] = groupPages([...README_PAGES, ...START_PAGES, KNOWLEDGE_PAGE]).flatMap((group) => group.pages);

/** The page that lists the current version and the earlier ones; only in a site with earlier versions (D-139). */
export const VERSIONS_PAGE: Page = { file: 'versions.html', nav: 'Versions', title: 'Versions', summary: 'The current version and the documentation of every earlier release.' };

const read = (root: URL, path: string) => readFileSync(new URL(path, root), 'utf8');

function readmeInputs(root: URL): ReadmeInputs {
  return { tools: knowledgeBase, environment, action: read(root, 'action.yml'), workflow: read(root, '.github/workflows/ci.yml') };
}

/** README.md with its generated sections rendered from the sources, as npm run docs:readme writes it. */
export function freshReadme(root: URL = REPOSITORY): string {
  return renderReadme(read(root, 'README.md'), readmeInputs(root));
}

/** A part of a page: Markdown, a README section at a level, or HTML the build writes, with ids from the page's slugger. */
type Part = { markdown: string } | { section: Section; level: number } | { html: (slug: (text: string) => string) => string };

/** The README sections of each README page, in README order. */
function assignSections(sections: readonly Section[]): Map<ReadmePage, Section[]> {
  const named = new Map<string, ReadmePage>();
  for (const page of README_PAGES) {
    for (const id of page.sections) {
      if (named.has(id)) throw new Error(`site: README section #${id} is on two pages`);
      if (!sections.some((section) => section.id === id)) throw new Error(`site: README.md has no section #${id} for ${page.file}`);
      named.set(id, page);
    }
  }
  const rest = README_PAGES.find((page) => page.rest === true);
  const result = new Map<ReadmePage, Section[]>(README_PAGES.map((page) => [page, []]));
  // The sections a section lies in, below the title of the README: their page is its page unless it is named.
  const parents: { level: number; page: ReadmePage }[] = [];
  for (const section of sections) {
    while ((parents.at(-1)?.level ?? 0) >= section.level) parents.pop();
    const page = named.get(section.id) ?? parents.at(-1)?.page ?? rest;
    if (page === undefined) throw new Error(`site: README section #${section.id} is on no page`);
    if (section.level > 1) parents.push({ level: section.level, page });
    result.get(page)?.push(section);
  }
  return result;
}

interface Context {
  /** The page of each README section id. */
  anchors: Map<string, string>;
  /** The name of the package, for its page on npm. */
  name: string;
  version: string;
  description: string;
  license: string;
  repository: string | undefined;
  template: string;
  /** The pages in the navigation of the current version: SITE_PAGES, and the Versions page with earlier versions. */
  pages: readonly Page[];
}

/** A link target of README or knowledge text as it works on the site, on `file` that shows the sections `local`. */
function siteTarget(target: string, file: string, local: ReadonlySet<string>, context: Context): string {
  if (target === KNOWLEDGE_DOCUMENT) return 'knowledge.html';
  if (target.startsWith(`${KNOWLEDGE_DOCUMENT}#`)) return `knowledge.html${target.slice(KNOWLEDGE_DOCUMENT.length)}`;
  if (!target.startsWith('#')) return target;
  const id = decodeURIComponent(target.slice(1));
  const page = context.anchors.get(id);
  if (page === undefined) throw new Error(`site: ${file} links to ${target}, which no README section has`);
  return local.has(id) || page === file ? target : `${page}${target}`;
}

/** The ids of the sections among the parts, which keep the id they have in their document. */
function sectionIds(parts: readonly Part[]): Set<string> {
  return new Set(parts.flatMap((part) => ('section' in part ? [part.section.id] : [])));
}

/** The HTML of the parts; the ids of the sections in `reserved` (by default those of the parts) are never given twice. */
function renderParts(parts: readonly Part[], href: (target: string) => string | undefined, reserved: ReadonlySet<string> = sectionIds(parts)): string {
  const slug = createSlugger(['content', ...reserved]);
  return parts
    .map((part) => {
      if ('html' in part) return part.html(slug);
      if ('markdown' in part) return renderMarkdown(part.markdown, { slug, href }).html;
      const { section, level } = part;
      return renderMarkdown(`${'#'.repeat(level)} ${section.heading}\n${section.body}`, { slug: () => section.id, href }).html;
    })
    .join('');
}

/**
 * A page of the current version, with the links of README and knowledge text as they work on the site. The first part
 * of a page with a hero, the title of the README with its introduction, is in the hero (D-140).
 */
function currentPage(page: Page, parts: readonly Part[], context: Context, hero = false): string {
  const local = sectionIds(parts);
  const href = (target: string) => siteTarget(target, page.file, local, context);
  const [first, ...rest] = parts;
  const lead = hero && first !== undefined ? renderParts([first], href, local) : '';
  const content = renderParts(hero ? rest : parts, href, local);
  return pageHtml({ ...currentFrame(page, context), hero: hero ? heroHtml(lead, page, context) : '' }, content, context.template);
}

/** The button of the hero that leads to the five-minute start of the README. */
const FIVE_MINUTE_START = 'five-minute-start';

/**
 * The hero of the start page (D-140): the icon, the title of the README with its introduction, buttons to the
 * five-minute start, the repository and the package on npm, and every tool of the knowledge base as a chip that links
 * to the start page of its group.
 */
function heroHtml(lead: string, page: Page, context: Context): string {
  if (!lead.startsWith('<h1 ')) throw new Error(`site: the hero of ${page.file} needs the title of README.md as its first section`);
  if (context.anchors.get(FIVE_MINUTE_START) !== page.file) throw new Error(`site: the button "Start in five minutes" needs the README section #${FIVE_MINUTE_START} on ${page.file}`);
  const chips = knowledgeBase.map((tool) => {
    const start = START_PAGES.find((entry) => entry.tools.includes(tool.id));
    if (start === undefined) throw new Error(`site: ${tool.id} has no start page`);
    return `<li><a href="${escapeHtml(start.file)}">${escapeHtml(tool.name)}</a></li>`;
  });
  return [
    '<div class="hero">',
    `<img class="logo" src="${rootOf(page.file)}favicon.svg" alt="" width="96" height="96">`,
    lead.trimEnd(),
    '<p class="actions">',
    `<a class="button primary" href="#${FIVE_MINUTE_START}">Start in five minutes</a>`,
    ...(context.repository === undefined ? [] : [`<a class="button" href="${escapeHtml(context.repository)}">GitHub</a>`]),
    `<a class="button" href="${escapeHtml(`https://www.npmjs.com/package/${context.name}`)}">npm</a>`,
    '</p>',
    '<ul class="chips" aria-label="Supported tools">',
    ...chips,
    '</ul>',
    '</div>',
    '',
  ].join('\n');
}

function readmeParts(page: ReadmePage, sections: readonly Section[], context: Context): Part[] {
  const top = Math.min(...sections.map((section) => section.level));
  if (page.heading !== true && (sections[0]?.level !== top || sections.filter((section) => section.level === top).length !== 1)) {
    throw new Error(`site: ${page.file} needs a heading of its own, because its README sections do not start with a single one at the top`);
  }
  const shift = top - (page.heading === true ? 2 : 1);
  return [
    ...(page.heading === true ? [{ markdown: `# ${page.title}` }] : []),
    ...sections.map((section) => ({ section, level: section.level - shift })),
    ...(page.extra === undefined ? [] : [{ markdown: page.extra }]),
    ...(page.contents === true ? [contents(page, context.pages)] : []),
  ];
}

/** The other pages of the site with their summaries, in the groups of the navigation (D-140). */
function contents(page: Page, pages: readonly Page[]): Part {
  return {
    html: (slug) => {
      const groups = groupPages(pages.filter((entry) => entry.file !== page.file));
      const lines = [`<h2 id="${escapeHtml(slug('On this site'))}">On this site</h2>`];
      for (const group of groups) {
        lines.push(`<h3 id="${escapeHtml(slug(group.title))}">${escapeHtml(group.title)}</h3>`, '<ul class="cards">');
        // The colon is for screen readers, which read the link as one name: "Title: summary" (decision D-141).
        for (const entry of group.pages) lines.push(`<li><a href="${escapeHtml(entry.file)}"><span class="title">${escapeHtml(entry.title)}</span><span class="visually-hidden">:</span> <span class="summary">${escapeHtml(entry.summary)}</span></a></li>`);
        lines.push('</ul>');
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

function sectionById(sections: readonly Section[], id: string, file: string): Section {
  const section = sections.find((entry) => entry.id === id);
  if (section === undefined) throw new Error(`site: README.md has no section #${id} for ${file}`);
  return section;
}

/** Whether a Markdown table has a row below its header and delimiter row. */
function hasRows(table: string): boolean {
  return table.split('\n').filter((line) => line.trimStart().startsWith('|')).length > 2;
}

function startParts(page: StartPage, sections: readonly Section[], root: URL, knowledgeIds: ReadonlyMap<string, string>): Part[] {
  const tools = knowledgeBase.filter((tool) => page.tools.includes(tool.id));
  const generated = readmeSections({ ...readmeInputs(root), tools });
  const managers = tools.filter((tool) => tool.kind === 'package-manager');
  const sources = tools.map((tool) => {
    const id = knowledgeIds.get(tool.name);
    return `[${tool.name}](knowledge.html${id === undefined ? '' : `#${id}`})`;
  });
  return [
    { markdown: `# ${page.title}\n\nWhat the [README](index.html) and the [knowledge base](knowledge.html) say about these tools, on one page.` },
    { section: sectionById(sections, 'five-minute-start', page.file), level: 2 },
    ...page.guide.map((id) => ({ section: sectionById(sections, id, page.file), level: 2 })),
    { markdown: `## Supported tools\n\n${generated['tools'] ?? ''}` },
    // A tool without user files (Composer) has no row in that table: the section is left out.
    ...(managers.length === 0 || !hasRows(generated['user-config'] ?? '')
      ? []
      : [{ markdown: `## Protecting the whole machine\n\n${generated['user-config'] ?? ''}\n\nMore: [Protecting the whole machine](machine.html).` }]),
    ...(page.rules.length === 0
      ? []
      : [
          { markdown: '## doctor rules for these tools' },
          ...page.rules.map((id) => ({ section: sectionById(sections, id, page.file), level: 3 })),
          { markdown: 'Every rule: [doctor rules](doctor.html).' },
        ]),
    { markdown: `## Sources\n\nEvery fact behind these tables, with its official source, is in the knowledge base: ${sources.join(', ')}.` },
  ];
}

interface NavEntry {
  href: string;
  text: string;
  current: boolean;
}

/** A group of the navigation as the page shows it. */
interface NavGroup {
  title: string;
  entries: readonly NavEntry[];
}

/** What site/template.html puts around the content of a page. */
interface Frame {
  /** The path of the page from the root of the site, which gives the relative path back to the root. */
  file: string;
  title: string;
  description: string;
  /** The version the page documents, in the top bar. */
  version: string;
  nav: readonly NavGroup[];
  /** HTML before the content: the banner of an earlier version, empty for the current one. */
  banner: string;
  /** HTML of the hero above the content (D-140), empty on every page but the start page. */
  hero: string;
  /** HTML of the footer. */
  footer: string;
}

/** The relative path from a page to the root of the site: empty at the root, `../` in a version directory. */
const rootOf = (file: string) => '../'.repeat(file.split('/').length - 1);

function navHtml(groups: readonly NavGroup[]): string {
  return groups
    .map((group) =>
      [
        '<div class="group">',
        `<p class="group-title">${escapeHtml(group.title)}</p>`,
        '<ul>',
        ...group.entries.map((entry) => `<li><a href="${escapeHtml(entry.href)}"${entry.current ? ' aria-current="page"' : ''}>${escapeHtml(entry.text)}</a></li>`),
        '</ul>',
        '</div>',
      ].join('\n'),
    )
    .join('\n');
}

/** The level words of doctor rules (`**error** · …`) and the labels of the lists of codes of init and apply (D-140). */
const LEVEL_WORD = /<strong>(error|warning|note)<\/strong>/gu;
const LEVEL_LIST = /<p>(Errors|Warnings|Notes)((?: \([^)<]*\))?):<\/p>\n<ul>\n([\s\S]*?)\n<\/ul>/gu;
const LIST_LEVEL: Record<string, string> = { Errors: 'error', Warnings: 'warning', Notes: 'note' };

/**
 * The levels as pills with their word (D-140): the level of a doctor rule, written in bold, gets the class of its level,
 * and each code in a list under "Warnings:", "Notes:" or "Errors (…):" gets a pill with the level of the list.
 */
export function levelPills(html: string): string {
  return html.replace(LEVEL_WORD, '<strong class="level level-$1">$1</strong>').replace(LEVEL_LIST, (_match, label: string, rest: string, items: string) => {
    const level = LIST_LEVEL[label] ?? 'note';
    return `<p>${label}${rest}:</p>\n<ul class="codes">\n${items.replaceAll('<li>', `<li><span class="level level-${level}">${level}</span> `)}\n</ul>`;
  });
}

/** A page lists its headings under "On this page" from this many h2 headings on (D-140). */
const ON_THIS_PAGE_MINIMUM = 2;
/** The list has the h3 headings too when the page has at most this many. */
const ON_THIS_PAGE_H3 = 6;

/**
 * The "On this page" list of the h2 headings of the content, with the h3 headings under them when the page has few
 * (D-140), after the details element that opens it on narrow screens; empty for a page with fewer h2 headings.
 */
function onThisPage(content: string): string {
  const headings = [...content.matchAll(/<h([23]) id="([^"]*)">([\s\S]*?)<\/h\1>/gu)].map((match) => ({
    level: Number(match[1]),
    id: match[2] ?? '',
    // Links in a heading would be links in a link.
    html: (match[3] ?? '').replace(/<\/?a\b[^>]*>/gu, ''),
  }));
  const h2 = headings.filter((heading) => heading.level === 2);
  if (h2.length < ON_THIS_PAGE_MINIMUM) return '';
  const shown = headings.length - h2.length <= ON_THIS_PAGE_H3 ? headings : h2;
  // Each h3 heading under the h2 heading before it.
  const tree: { heading: (typeof headings)[number]; children: typeof headings }[] = [];
  for (const heading of shown) {
    const parent = tree.at(-1);
    if (heading.level === 3 && parent?.heading.level === 2) parent.children.push(heading);
    else tree.push({ heading, children: [] });
  }
  const link = (heading: (typeof headings)[number]) => `<a href="#${heading.id}">${heading.html}</a>`;
  const lines = tree.map(({ heading, children }) =>
    children.length === 0 ? `<li>${link(heading)}</li>` : [`<li>${link(heading)}`, '<ul>', ...children.map((child) => `<li>${link(child)}</li>`), '</ul></li>'].join('\n'),
  );
  return [
    '<details class="toc-toggle"><summary>On this page</summary></details>',
    '<nav class="toc" aria-label="On this page">',
    '<p class="toc-title">On this page</p>',
    '<ul>',
    ...lines,
    '</ul>',
    '</nav>',
    '',
  ].join('\n');
}

function pageHtml(frame: Frame, content: string, template: string): string {
  const body = levelPills(content.trimEnd());
  const values: Record<string, string> = {
    title: escapeHtml(frame.title),
    description: escapeHtml(frame.description),
    root: rootOf(frame.file),
    version: escapeHtml(frame.version),
    nav: navHtml(frame.nav),
    banner: frame.banner,
    hero: frame.hero,
    toc: onThisPage(body),
    content: body,
    footer: frame.footer,
  };
  const used = new Set<string>();
  const html = template.replace(/\{\{(\w+)\}\}/gu, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`site: unknown placeholder {{${key}}} in site/template.html`);
    used.add(key);
    return value;
  });
  const missing = Object.keys(values).filter((key) => !used.has(key));
  if (missing.length > 0) throw new Error(`site: site/template.html has no ${missing.map((key) => `{{${key}}}`).join(', ')}`);
  return html;
}

/** The frame of a page of the current version. */
function currentFrame(page: Page, context: Context): Frame {
  const source = context.repository === undefined ? '' : ` · <a href="${escapeHtml(context.repository)}">Source on GitHub</a>`;
  return {
    file: page.file,
    title: page.title === 'depcurfew' ? 'depcurfew' : `${page.title} · depcurfew`,
    description: context.description,
    version: context.version,
    nav: groupPages(context.pages).map((group) => ({
      title: group.title,
      entries: group.pages.map((entry) => ({ href: entry.file, text: entry.nav, current: entry.file === page.file })),
    })),
    banner: '',
    hero: '',
    footer: `<p>depcurfew ${escapeHtml(context.version)} · built from README.md and src/knowledge/ with <code>npm run site</code>${source} · ${escapeHtml(context.license)} license</p>`,
  };
}

// Earlier versions (decision D-139).

/** A page of an earlier version: a document of its tag. */
interface ArchivePage {
  /** The page in the directory of the version. */
  file: 'index.html' | 'knowledge.html' | 'changelog.html';
  /** The file of the tag the page shows, for relative links and messages. */
  source: 'README.md' | 'docs/knowledge.md' | 'CHANGELOG.md';
  nav: string;
  title: string;
  parts: Part[];
  /** The ids of its headings, as GitHub gives them in the source. */
  ids: Set<string>;
}

interface Archive {
  entry: ArchivedVersion;
  pages: ArchivePage[];
}

/** A whole document as parts: each section keeps the id GitHub gives it, so its own anchors work. */
function documentParts(markdown: string): Part[] {
  const { preamble, sections } = splitSections(markdown);
  return [...(preamble.trim() === '' ? [] : [{ markdown: preamble }]), ...sections.map((section) => ({ section, level: section.level }))];
}

/** The section of `version` in a CHANGELOG.md, with the heading of the page, or undefined when it has none. */
function changelogParts(changelog: string, version: string): Part[] | undefined {
  const { sections } = splitSections(changelog);
  // "## 1.3.0", also "## [1.3.0]", "## v1.3.0" or "## 1.3.0 (date)".
  const heading = new RegExp(`^\\[?v?${version.replaceAll('.', '\\.')}\\]?(?:$|[\\s(])`, 'u');
  const start = sections.findIndex((section) => section.level === 2 && heading.test(section.text));
  const own = sections[start];
  if (own === undefined) return undefined;
  const parts: Part[] = [{ section: { ...own, heading: `Changes in depcurfew ${version}` }, level: 1 }];
  for (const section of sections.slice(start + 1)) {
    if (section.level <= 2) break;
    parts.push({ section, level: section.level - 1 });
  }
  return parts;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A link target of a document of an earlier version as it works on the site: an anchor of the page stays, a file of the
 * repository that the version shows (README.md, docs/knowledge.md, CHANGELOG.md, schema.json) is its page when the
 * anchor is there, any other file of the repository is the file at the tag on GitHub, and other links stay. Undefined
 * drops the link and keeps its text, with a line passed to `report`.
 */
function archiveTarget(target: string, page: ArchivePage, archive: Archive, context: Context, report: (line: string) => void): string | undefined {
  const { entry } = archive;
  const where = `site: ${entry.version}/${page.file}: ${page.source} at tag ${entry.tag} links to ${target}`;
  const hash = target.indexOf('#');
  const path = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? '' : target.slice(hash);
  let fragment: string | undefined;
  try {
    fragment = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  } catch {
    fragment = target.slice(hash + 1);
  }
  if (path === '') {
    if (fragment !== undefined && page.ids.has(fragment)) return target;
    report(`${where}, which none of its headings has; the link is shown as text`);
    return undefined;
  }
  // A link to a file of the repository: on GitHub, at any branch or commit, or relative to the document.
  let file: { kind: string; path: string } | undefined;
  for (const repository of new Set([context.repository, entry.repository])) {
    if (repository === undefined) continue;
    const match = new RegExp(`^${escapeRegExp(repository)}/(blob|tree)/[^/]+/(.+)$`, 'iu').exec(path);
    if (match !== null) file = { kind: match[1] ?? 'blob', path: match[2] ?? '' };
  }
  if (file === undefined) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(path) || path.startsWith('/')) return target;
    const resolved = posix.normalize(posix.join(posix.dirname(page.source), path)).replace(/\/$/u, '');
    if (resolved === '..' || resolved.startsWith('../')) {
      report(`${where}, outside the repository; the link is shown as text`);
      return undefined;
    }
    file = { kind: 'blob', path: resolved };
  }
  const shown = archive.pages.find((other) => other.source === file.path);
  if (shown !== undefined && (fragment === undefined || shown.ids.has(fragment))) return `${shown.file}${anchor}`;
  if (file.path === 'schema.json' && entry.schema !== undefined && fragment === undefined) return 'schema.json';
  const repository = context.repository ?? entry.repository;
  if (repository === undefined) {
    report(`${where}, a file of the repository, but package.json has no https address of the repository; the link is shown as text`);
    return undefined;
  }
  return `${repository}/${file.kind}/${entry.tag}/${file.path}${anchor}`;
}

/** "a", "a and b", "a, b and c". */
function enumeration(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

function archiveOf(entry: ArchivedVersion, report: (line: string) => void): Archive {
  const version = entry.version;
  const pages: Omit<ArchivePage, 'ids'>[] = [{ file: 'index.html', source: 'README.md', nav: 'README', title: `depcurfew ${version}`, parts: documentParts(entry.readme) }];
  if (entry.knowledge !== undefined) pages.push({ file: 'knowledge.html', source: 'docs/knowledge.md', nav: 'Knowledge base', title: `Knowledge base · depcurfew ${version}`, parts: documentParts(entry.knowledge) });
  if (entry.changelog !== undefined) {
    const parts = changelogParts(entry.changelog, version);
    if (parts === undefined) report(`site: CHANGELOG.md at tag ${entry.tag} has no section "## ${version}", so ${version}/ has no changes page`);
    else pages.push({ file: 'changelog.html', source: 'CHANGELOG.md', nav: `Changes in ${version}`, title: `Changes in ${version} · depcurfew ${version}`, parts });
  }
  return { entry, pages: pages.map((page) => ({ ...page, ids: sectionIds(page.parts) })) };
}

/** The files of an earlier version in its directory: its pages with a banner and its schema.json. */
function archiveFiles(archive: Archive, context: Context, report: (line: string) => void): Map<string, string | Buffer> {
  const { entry } = archive;
  const version = escapeHtml(entry.version);
  const source = context.repository ?? entry.repository;
  const footer = `<p>depcurfew ${version} · from ${enumeration(archive.pages.map((page) => page.source))} at tag ${escapeHtml(entry.tag)}, built with <code>npm run site -- --versions</code>${
    source === undefined ? '' : ` · <a href="${escapeHtml(`${source}/tree/${entry.tag}`)}">Source on GitHub</a>`
  } · ${escapeHtml(entry.license ?? context.license)} license</p>`;
  const banner = `<p class="banner">This page documents depcurfew ${version}, an earlier version. The current version is ${escapeHtml(context.version)}: <a href="../index.html">its documentation</a> · <a href="../${VERSIONS_PAGE.file}">all versions</a></p>\n`;
  const files = new Map<string, string | Buffer>();
  for (const page of archive.pages) {
    // The pages of this version, then the other versions (D-140).
    const nav: NavGroup[] = [
      { title: `depcurfew ${entry.version}`, entries: archive.pages.map((other) => ({ href: other.file, text: other.nav, current: other.file === page.file })) },
      {
        title: 'Other versions',
        entries: [
          { href: `../${VERSIONS_PAGE.file}`, text: VERSIONS_PAGE.nav, current: false },
          { href: '../index.html', text: `Current version (${context.version})`, current: false },
        ],
      },
    ];
    const frame: Frame = { file: `${entry.version}/${page.file}`, title: page.title, description: entry.description ?? context.description, version: entry.version, nav, banner, hero: '', footer };
    files.set(frame.file, pageHtml(frame, renderParts(page.parts, (target) => archiveTarget(target, page, archive, context, report)), context.template));
  }
  if (entry.schema !== undefined) files.set(`${entry.version}/schema.json`, entry.schema);
  return files;
}

/** The Markdown of the Versions page: the current version, then every earlier one, newest first. */
function versionsMarkdown(archives: readonly Archive[], context: Context): string {
  const changes = context.repository === undefined ? '-' : `[CHANGELOG.md](${context.repository}/blob/v${context.version}/CHANGELOG.md#${slugify(context.version)})`;
  const link = (archive: Archive, file: ArchivePage['file']) => {
    const page = archive.pages.find((entry) => entry.file === file);
    return page === undefined ? '-' : `[${page.nav}](${archive.entry.version}/${page.file})`;
  };
  return [
    `# ${VERSIONS_PAGE.title}`,
    '',
    `The pages at the root of this site document depcurfew ${context.version}, the current version. Every earlier release from ${FIRST_ARCHIVED_VERSION} on keeps the README, the knowledge base, the changes and the JSON Schema of its release tag, with a banner on each page that names its version.`,
    '',
    '| Version | Documentation | Knowledge base | Changes | JSON Schema |',
    '| --- | --- | --- | --- | --- |',
    `| ${context.version} (current) | [${SITE_PAGES[0]?.nav ?? 'Overview'}](index.html) | [${KNOWLEDGE_PAGE.nav}](knowledge.html) | ${changes} | [schema.json](schema.json) |`,
    ...archives.map((archive) => {
      const schema = archive.entry.schema === undefined ? '-' : `[schema.json](${archive.entry.version}/schema.json)`;
      return `| ${archive.entry.version} | ${link(archive, 'index.html')} | ${link(archive, 'knowledge.html')} | ${link(archive, 'changelog.html')} | ${schema} |`;
    }),
  ].join('\n');
}

export interface SiteOptions {
  /** Earlier versions, from readVersions; without any, only the current version is built. */
  versions?: readonly ArchivedVersion[];
  /** Receives a line for each link of an earlier version that the site cannot keep. */
  report?: (line: string) => void;
}

/** Every file of the site by its path, from the sources in `root`. */
export function renderSite(root: URL = REPOSITORY, options: SiteOptions = {}): Map<string, string | Buffer> {
  const versions = options.versions ?? [];
  const report = options.report ?? (() => undefined);
  const pkg = JSON.parse(read(root, 'package.json')) as { name: string; version: string; description: string; license: string; repository?: unknown };
  const { preamble, sections } = splitSections(freshReadme(root));
  if (preamble.trim() !== '') throw new Error('site: README.md has text before its first heading, which no page would show');
  const assigned = assignSections(sections);
  const anchors = new Map<string, string>();
  for (const [page, list] of assigned) for (const section of list) anchors.set(section.id, page.file);
  const context: Context = {
    anchors,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    repository: repositoryUrl(pkg.repository),
    // The address of the stylesheet changes with its content, so that a browser does not keep a cached one after a
    // change of the site (decision D-147).
    template: read(root, 'site/template.html').replaceAll('{{stamp}}', createHash('sha256').update(read(root, 'site/style.css')).digest('hex').slice(0, 12)),
    pages: versions.length === 0 ? SITE_PAGES : [...SITE_PAGES, VERSIONS_PAGE],
  };

  const files = new Map<string, string | Buffer>();
  for (const page of README_PAGES) files.set(page.file, currentPage(page, readmeParts(page, assigned.get(page) ?? [], context), context, page.hero === true));

  const knowledge = renderMarkdown(renderKnowledgeMarkdown(knowledgeBase, environment), {
    slug: createSlugger(['content']),
    href: (target) => siteTarget(target, KNOWLEDGE_PAGE.file, new Set(), context),
  });
  files.set(KNOWLEDGE_PAGE.file, pageHtml(currentFrame(KNOWLEDGE_PAGE, context), knowledge.html, context.template));
  // The first heading of each tool in the knowledge base, for the links of the start pages.
  const knowledgeIds = new Map<string, string>();
  for (const heading of knowledge.headings) if (!knowledgeIds.has(heading.text)) knowledgeIds.set(heading.text, heading.id);

  for (const page of START_PAGES) files.set(page.file, currentPage(page, startParts(page, sections, root, knowledgeIds), context));

  files.set('style.css', read(root, 'site/style.css'));
  files.set('favicon.svg', readFileSync(new URL('site/favicon.svg', root)));
  const schema = readFileSync(new URL('schema.json', root));
  files.set('schema.json', schema);
  files.set('schema/v1.json', schema);

  if (versions.length > 0) {
    const seen = new Set<string>();
    for (const entry of versions) {
      if (!/^\d+\.\d+\.\d+$/u.test(entry.version) || seen.has(entry.version)) throw new Error(`site: ${entry.version} is not one release version`);
      seen.add(entry.version);
    }
    const archives = versions.map((entry) => archiveOf(entry, report));
    for (const archive of archives) for (const [path, content] of archiveFiles(archive, context, report)) files.set(path, content);
    const page = renderMarkdown(versionsMarkdown(archives, context), { slug: createSlugger(['content']) });
    files.set(VERSIONS_PAGE.file, pageHtml(currentFrame(VERSIONS_PAGE, context), page.html, context.template));
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Writes the files of renderSite into `directory`, which must exist or will be created; returns their paths. */
export function writeSite(files: ReadonlyMap<string, string | Buffer>, directory: string): string[] {
  for (const [path, content] of files) {
    const target = join(directory, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return [...files.keys()];
}

export function buildSite(directory: string, root: URL = REPOSITORY, options: SiteOptions = {}): string[] {
  return writeSite(renderSite(root, options), directory);
}
