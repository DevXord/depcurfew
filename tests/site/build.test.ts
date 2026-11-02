// The documentation site (decision D-132): a full build into a temporary directory has every page, every internal
// link and anchor resolves, nothing loads from another host, two builds give the same bytes, and the served schema
// is schema.json.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite, freshReadme, README_PAGES, SITE_PAGES, START_PAGES } from '../../scripts/site/build.ts';
import { escapeHtml, splitSections } from '../../scripts/site/markdown.ts';
import { APPLY_ERRORS, APPLY_WARNINGS } from '../../src/apply/warnings.ts';
import { INIT_NOTES, INIT_WARNINGS } from '../../src/cli/init-codes.ts';
import { RULES } from '../../src/doctor/index.ts';
import { evidenceOf, collectFacts } from '../../src/knowledge/facts.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';
import { USER_RULES } from '../../src/user/doctor.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

// The start pages follow the ecosystems of the knowledge base; npm, Python and the bots have one each.
const PAGES = [
  'index.html',
  ...START_PAGES.map((entry) => entry.file),
  'policy.html',
  'commands.html',
  'codes.html',
  'doctor.html',
  'machine.html',
  'tools.html',
  'action.html',
  'check.html',
  'claude-code.html',
  'mcp.html',
  'knowledge.html',
  'about.html',
];
const FILES = [...PAGES, 'schema.json', 'schema/v1.json', 'style.css'].sort();

let directories: string[] = [];
let site = '';

/** The files under a directory, as paths with `/`. */
function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const page = (name: string) => readFileSync(join(site, name), 'utf8');

/** Every attribute value of the page with the element it is on. */
function attributes(html: string): { tag: string; name: string; value: string }[] {
  const found: { tag: string; name: string; value: string }[] = [];
  for (const element of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/gu)) {
    const [, tag = '', rest = ''] = element;
    for (const attribute of rest.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/gu)) found.push({ tag: tag.toLowerCase(), name: (attribute[1] ?? '').toLowerCase(), value: attribute[2] ?? '' });
  }
  return found;
}

const unescape = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const ids = (html: string) => [...html.matchAll(/\sid="([^"]*)"/gu)].map((match) => unescape(match[1] ?? ''));
const isExternal = (value: string) => /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith('//');

beforeAll(() => {
  directories = [mkdtempSync(join(tmpdir(), 'depcurfew-site-')), mkdtempSync(join(tmpdir(), 'depcurfew-site-'))];
  site = directories[0] ?? '';
  for (const directory of directories) buildSite(directory);
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('site build', () => {
  it('writes every page, the stylesheet and the schema, and nothing else', () => {
    expect(files(site)).toEqual(FILES);
    expect(START_PAGES.map((entry) => entry.file)).toEqual(expect.arrayContaining(['npm.html', 'python.html', 'bots.html']));
    expect(SITE_PAGES.map((entry) => entry.file)).toEqual(PAGES);
  });

  it('gives the same bytes in two builds', () => {
    const [first = '', second = ''] = directories;
    expect(files(second)).toEqual(files(first));
    for (const name of files(first)) expect(readFileSync(join(second, name)).equals(readFileSync(join(first, name))), name).toBe(true);
  });

  it('serves schema.json at schema.json and schema/v1.json', () => {
    const schema = readFileSync(new URL('schema.json', ROOT));
    expect(readFileSync(join(site, 'schema.json')).equals(schema)).toBe(true);
    expect(readFileSync(join(site, 'schema/v1.json')).equals(schema)).toBe(true);
  });

  it.each(PAGES)('%s is a complete HTML page with one h1 and the navigation', (name) => {
    const html = page(name);
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<link rel="stylesheet" href="style.css">');
    expect(html).toMatch(/<title>[^<]+<\/title>/u);
    expect(html.match(/<h1[ >]/gu)?.length).toBe(1);
    expect(html).not.toMatch(/\{\{(title|description|nav|content|footer)\}\}/u);
    for (const other of PAGES) expect(html, `${name} links to ${other}`).toContain(`href="${other}"`);
    expect(html).toContain(`href="${name}" aria-current="page"`);
  });

  it.each(PAGES)('%s resolves every internal link and anchor, with relative paths only', (name) => {
    const html = page(name);
    const own = new Set(ids(html));
    expect(own.size, 'duplicate ids').toBe(ids(html).length);
    for (const { name: attribute, value: raw } of attributes(html)) {
      if (!['href', 'src', 'srcset', 'action', 'poster', 'data', 'formaction'].includes(attribute)) continue;
      const value = unescape(raw);
      if (isExternal(value)) continue;
      expect(value.startsWith('/'), `${name}: ${value} is not relative`).toBe(false);
      const [path = '', fragment] = value.split('#');
      const target = path === '' ? name : posix.normalize(posix.join(posix.dirname(name), path));
      expect(FILES, `${name}: ${value}`).toContain(target);
      if (fragment !== undefined) {
        const targetIds = target === name ? own : new Set(ids(page(target)));
        expect(targetIds.has(decodeURIComponent(fragment)), `${name}: ${value} has no anchor`).toBe(true);
      }
    }
  });

  it.each(PAGES)('%s loads nothing: no scripts, frames, images, styles from elsewhere or external URLs outside links', (name) => {
    const html = page(name);
    expect(html).not.toMatch(/<(script|iframe|img|object|embed|video|audio|source|picture|form|base|meta http-equiv)\b/iu);
    expect(html).not.toMatch(/\sstyle="/u);
    expect(html).not.toMatch(/\son\w+="/u);
    for (const { tag, name: attribute, value } of attributes(html)) {
      if (tag === 'a' && attribute === 'href') {
        if (isExternal(unescape(value))) expect(unescape(value), name).toMatch(/^(https?|mailto):/u);
        continue;
      }
      expect(isExternal(unescape(value)), `${name}: <${tag} ${attribute}="${value}">`).toBe(false);
    }
    for (const link of html.matchAll(/<link\b[^>]*>/gu)) expect(link[0]).toBe('<link rel="stylesheet" href="style.css">');
  });

  it('has a stylesheet with a light and a dark color scheme that loads nothing', () => {
    const css = readFileSync(join(site, 'style.css'), 'utf8');
    expect(css).toBe(read('site/style.css'));
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toMatch(/color-scheme:\s*light dark/u);
    expect(css).not.toMatch(/url\(|@import|@font-face/u);
  });
});

describe('site content', () => {
  const readme = () => splitSections(freshReadme()).sections;

  it('puts every README section on exactly one README page', () => {
    for (const section of readme()) {
      const pages = README_PAGES.filter((entry) => ids(page(entry.file)).includes(section.id));
      expect(pages.map((entry) => entry.file), `README section #${section.id}`).toHaveLength(1);
    }
  });

  it('keeps the README text: every list item and paragraph of the README pages', () => {
    const shown = README_PAGES.map((entry) => page(entry.file)).join('\n');
    for (const section of readme()) {
      for (const line of section.body.split('\n')) {
        // Plain lines without Markdown syntax appear as they are, escaped.
        if (line === '' || /[`*_[\]<>|\\#]/u.test(line) || /^(\d+\.|-) /u.test(line) || line.startsWith('```')) continue;
        expect(shown, line).toContain(escapeHtml(line));
      }
    }
  });

  it('shows every knowledge base source as a link', () => {
    const html = page('knowledge.html');
    const sources = new Set<string>();
    for (const entry of [...knowledgeBase, environment]) {
      for (const { fact } of collectFacts(entry)) for (const evidence of evidenceOf(fact)) sources.add(evidence.source);
    }
    expect(sources.size).toBeGreaterThan(100);
    for (const source of sources) expect(html, source).toContain(`href="${escapeHtml(source)}"`);
  });

  it('has an anchor for every doctor rule and every doctor --user rule', () => {
    for (const rule of RULES) expect(ids(page('doctor.html')), rule.id).toContain(rule.id);
    for (const rule of USER_RULES) expect(ids(page('machine.html')), rule.id).toContain(rule.id);
  });

  it('lists every code of apply and init', () => {
    const html = page('codes.html');
    for (const code of Object.keys({ ...APPLY_WARNINGS, ...APPLY_ERRORS, ...INIT_WARNINGS, ...INIT_NOTES })) expect(html, code).toContain(`<code>${code}</code>`);
  });

  it('lists every other page on the start page', () => {
    const html = page('index.html');
    expect(html).toContain('<h2 id="on-this-site">On this site</h2>');
    for (const entry of SITE_PAGES.filter((other) => other.file !== 'index.html')) expect(html).toContain(`<li><a href="${entry.file}">${escapeHtml(entry.title)}</a>: `);
  });

  it('links the policy page to the schema', () => {
    const html = page('policy.html');
    expect(html).toContain('href="schema.json"');
    expect(html).toContain('href="schema/v1.json"');
  });

  it('links the knowledge base document of the README to the knowledge page', () => {
    for (const name of PAGES) expect(page(name), name).not.toContain('blob/main/docs/knowledge.md');
    expect(page('tools.html')).toContain('href="knowledge.html"');
  });

  it('gives every tool of the knowledge base a row on the start page of its ecosystem', () => {
    for (const tool of knowledgeBase) {
      const start = START_PAGES.find((entry) => entry.tools.includes(tool.id));
      expect(start, tool.id).toBeDefined();
      expect(page(start?.file ?? ''), tool.id).toContain(`<tr><td>${escapeHtml(tool.name)}</td>`);
      for (const other of START_PAGES.filter((entry) => entry !== start)) expect(page(other.file), `${tool.id} on ${other.file}`).not.toContain(`<tr><td>${escapeHtml(tool.name)}</td>`);
    }
    expect(page('npm.html')).toContain('id="five-minute-start"');
    expect(page('python.html')).toContain('id="python-projects"');
    expect(page('bots.html')).toContain('id="bot-cooldown-mismatch"');
    expect(page('php.html')).toContain('id="composer-projects"');
    expect(page('php.html')).toContain('id="composer-config-weakens"');
  });

  it('leaves out a table without rows, such as the user files of a tool that has none', () => {
    for (const name of [...PAGES, ...START_PAGES.map((entry) => entry.file)]) expect(page(name), name).not.toMatch(/<\/thead>\s*<tbody>\s*<\/tbody>|<\/thead>\s*<\/table>/u);
    expect(page('php.html')).not.toContain('Protecting the whole machine');
  });
});

describe('repository', () => {
  it('runs the generator with npm run site and keeps the output out of git', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; files: string[] };
    expect(pkg.scripts['site']).toBe('node scripts/site.ts');
    expect(read('.gitignore').split('\n')).toContain('dist-site/');
    expect(pkg.files).not.toContain('site');
  });
});
