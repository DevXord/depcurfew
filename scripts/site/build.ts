// The documentation site (decision D-132), built from the sources of README.md so that it cannot drift from it:
// README.md with its generated sections rendered afresh, the knowledge base as docs/knowledge.md shows it, and
// schema.json. Every page is the README text of its sections, the knowledge base, or a start page for one ecosystem
// that puts README sections and the README tables of its tools together. Hand-written text is limited to
// navigation. Links are relative, so the site works as a project site (https://<owner>.github.io/depcurfew/) and at
// the root of a domain; nothing is loaded from another host.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KNOWLEDGE_DOCUMENT, readmeSections, renderReadme, type ReadmeInputs } from '../../src/docs/readme.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../../src/knowledge/render.ts';
import type { Ecosystem, ToolId, ToolKnowledge } from '../../src/knowledge/types.ts';
import { createSlugger, escapeHtml, renderMarkdown, splitSections, type Section } from './markdown.ts';

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
  npm: { file: 'npm.html', nav: 'JavaScript', guide: [], rules: ['npmrc-overrides-policy', 'pnpm-shared-workspace-lockfile'] },
  pypi: { file: 'python.html', nav: 'Python', guide: ['python-projects'], rules: ['python-config-ignored', 'lockfile-out-of-date'] },
  packagist: { file: 'php.html', nav: 'PHP', guide: ['composer-projects'], rules: ['composer-config-weakens'] },
};
const BOTS_PAGE: EcosystemPage = { file: 'bots.html', nav: 'Bots', guide: [], rules: ['bot-cooldown-mismatch'] };

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
    return {
      ...page,
      title: `Start with ${names(members)}`,
      summary: `The five-minute start, the settings and the doctor rules for ${names(members)}.`,
      tools: members.map((tool) => tool.id),
    };
  });
}

export const START_PAGES: readonly StartPage[] = startPages(knowledgeBase);

/** Every page, in the order of the navigation. */
export const SITE_PAGES: readonly Page[] = [
  ...README_PAGES.slice(0, 1),
  ...START_PAGES,
  ...README_PAGES.slice(1, -1),
  KNOWLEDGE_PAGE,
  ...README_PAGES.slice(-1),
];

const read = (root: URL, path: string) => readFileSync(new URL(path, root), 'utf8');

function readmeInputs(root: URL): ReadmeInputs {
  return { tools: knowledgeBase, environment, action: read(root, 'action.yml'), workflow: read(root, '.github/workflows/ci.yml') };
}

/** README.md with its generated sections rendered from the sources, as npm run docs:readme writes it. */
export function freshReadme(root: URL = REPOSITORY): string {
  return renderReadme(read(root, 'README.md'), readmeInputs(root));
}

type Part = { markdown: string } | { section: Section; level: number };

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
  version: string;
  description: string;
  license: string;
  repository: string | undefined;
  template: string;
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

function renderParts(parts: readonly Part[], file: string, context: Context): string {
  const local = new Set(parts.flatMap((part) => ('section' in part ? [part.section.id] : [])));
  const slug = createSlugger(['content', ...local]);
  const href = (target: string) => siteTarget(target, file, local, context);
  return parts
    .map((part) => {
      if ('markdown' in part) return renderMarkdown(part.markdown, { slug, href }).html;
      const { section, level } = part;
      return renderMarkdown(`${'#'.repeat(level)} ${section.heading}\n${section.body}`, { slug: () => section.id, href }).html;
    })
    .join('');
}

function readmeParts(page: ReadmePage, sections: readonly Section[]): Part[] {
  const top = Math.min(...sections.map((section) => section.level));
  if (page.heading !== true && (sections[0]?.level !== top || sections.filter((section) => section.level === top).length !== 1)) {
    throw new Error(`site: ${page.file} needs a heading of its own, because its README sections do not start with a single one at the top`);
  }
  const shift = top - (page.heading === true ? 2 : 1);
  return [
    ...(page.heading === true ? [{ markdown: `# ${page.title}` }] : []),
    ...sections.map((section) => ({ section, level: section.level - shift })),
    ...(page.extra === undefined ? [] : [{ markdown: page.extra }]),
    ...(page.contents === true ? [{ markdown: contents(page) }] : []),
  ];
}

/** The other pages of the site with their summaries. */
function contents(page: Page): string {
  const entries = SITE_PAGES.filter((entry) => entry.file !== page.file).map((entry) => `- [${entry.title}](${entry.file}): ${entry.summary}`);
  return ['## On this site', '', ...entries].join('\n');
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

function pageHtml(page: Page, content: string, context: Context): string {
  const nav = SITE_PAGES.map((entry) => `<li><a href="${entry.file}"${entry.file === page.file ? ' aria-current="page"' : ''}>${escapeHtml(entry.nav)}</a></li>`).join('\n');
  const source = context.repository === undefined ? '' : ` · <a href="${escapeHtml(context.repository)}">Source on GitHub</a>`;
  const values: Record<string, string> = {
    title: escapeHtml(page.title === 'depcurfew' ? 'depcurfew' : `${page.title} · depcurfew`),
    description: escapeHtml(context.description),
    nav: `<ul>\n${nav}\n</ul>`,
    content: content.trimEnd(),
    footer: `<p>depcurfew ${escapeHtml(context.version)} · built from README.md and src/knowledge/ with <code>npm run site</code>${source} · ${escapeHtml(context.license)} license</p>`,
  };
  const used = new Set<string>();
  const html = context.template.replace(/\{\{(\w+)\}\}/gu, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`site: unknown placeholder {{${key}}} in site/template.html`);
    used.add(key);
    return value;
  });
  const missing = Object.keys(values).filter((key) => !used.has(key));
  if (missing.length > 0) throw new Error(`site: site/template.html has no ${missing.map((key) => `{{${key}}}`).join(', ')}`);
  return html;
}

/** The https address of the repository from package.json, for the footer. */
function repositoryUrl(repository: unknown): string | undefined {
  const url = typeof repository === 'string' ? repository : typeof repository === 'object' && repository !== null ? (repository as { url?: unknown }).url : undefined;
  if (typeof url !== 'string') return undefined;
  const plain = url.replace(/^git\+/u, '').replace(/\.git$/u, '');
  return plain.startsWith('https://') ? plain : undefined;
}

/** Every file of the site by its path, from the sources in `root`. */
export function renderSite(root: URL = REPOSITORY): Map<string, string | Buffer> {
  const pkg = JSON.parse(read(root, 'package.json')) as { version: string; description: string; license: string; repository?: unknown };
  const { preamble, sections } = splitSections(freshReadme(root));
  if (preamble.trim() !== '') throw new Error('site: README.md has text before its first heading, which no page would show');
  const assigned = assignSections(sections);
  const anchors = new Map<string, string>();
  for (const [page, list] of assigned) for (const section of list) anchors.set(section.id, page.file);
  const context: Context = {
    anchors,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    repository: repositoryUrl(pkg.repository),
    template: read(root, 'site/template.html'),
  };

  const files = new Map<string, string | Buffer>();
  for (const page of README_PAGES) files.set(page.file, pageHtml(page, renderParts(readmeParts(page, assigned.get(page) ?? []), page.file, context), context));

  const knowledge = renderMarkdown(renderKnowledgeMarkdown(knowledgeBase, environment), {
    slug: createSlugger(['content']),
    href: (target) => siteTarget(target, KNOWLEDGE_PAGE.file, new Set(), context),
  });
  files.set(KNOWLEDGE_PAGE.file, pageHtml(KNOWLEDGE_PAGE, knowledge.html, context));
  // The first heading of each tool in the knowledge base, for the links of the start pages.
  const knowledgeIds = new Map<string, string>();
  for (const heading of knowledge.headings) if (!knowledgeIds.has(heading.text)) knowledgeIds.set(heading.text, heading.id);

  for (const page of START_PAGES) files.set(page.file, pageHtml(page, renderParts(startParts(page, sections, root, knowledgeIds), page.file, context), context));

  files.set('style.css', read(root, 'site/style.css'));
  const schema = readFileSync(new URL('schema.json', root));
  files.set('schema.json', schema);
  files.set('schema/v1.json', schema);
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

export function buildSite(directory: string, root: URL = REPOSITORY): string[] {
  return writeSite(renderSite(root), directory);
}
