// The documentation site (decisions D-132, D-139 and D-140): a full build into a temporary directory has every page,
// every internal link and anchor resolves, nothing loads from another host, two builds give the same bytes, and the
// served schema is schema.json. Without --versions the site has no Versions page and no version directories. The
// design of D-140: the navigation in groups, the hero of the start page, the "On this page" list of long pages, the
// levels as pills and colors with enough contrast in both color schemes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite, freshReadme, groupPages, PAGE_GROUPS, README_PAGES, SITE_PAGES, START_PAGES, VERSIONS_PAGE } from '../../scripts/site/build.ts';
import { escapeHtml, splitSections } from '../../scripts/site/markdown.ts';
import { repositoryUrl } from '../../scripts/site/versions.ts';
import { APPLY_ERRORS, APPLY_WARNINGS } from '../../src/apply/warnings.ts';
import { INIT_NOTES, INIT_WARNINGS } from '../../src/cli/init-codes.ts';
import { RULES } from '../../src/doctor/index.ts';
import { evidenceOf, collectFacts } from '../../src/knowledge/facts.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';
import { USER_RULES } from '../../src/user/doctor.ts';
import { checkDocument, checkLinks, checkLoadsNothing, files, ids, navigation, onThisPage } from './pages.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const manifest = JSON.parse(read('package.json')) as { name: string; version: string; repository: unknown };

// The pages in the order of the navigation: Start, Reference, Integrations, then About. The start pages follow the
// ecosystems of the knowledge base; npm, Python, PHP and the bots have one each.
const PAGES = [
  'index.html',
  ...START_PAGES.map((entry) => entry.file),
  'policy.html',
  'commands.html',
  'codes.html',
  'doctor.html',
  'tools.html',
  'knowledge.html',
  'action.html',
  'check.html',
  'claude-code.html',
  'mcp.html',
  'machine.html',
  'about.html',
];
const FILES = [...PAGES, 'favicon.svg', 'schema.json', 'schema/v1.json', 'style.css'].sort();

let directories: string[] = [];
let site = '';

const page = (name: string) => readFileSync(join(site, name), 'utf8');

beforeAll(() => {
  directories = [mkdtempSync(join(tmpdir(), 'depcurfew-site-')), mkdtempSync(join(tmpdir(), 'depcurfew-site-'))];
  site = directories[0] ?? '';
  for (const directory of directories) buildSite(directory);
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('site build', () => {
  it('writes every page, the stylesheet, the icon and the schema, and nothing else: no Versions page or version directories', () => {
    expect(files(site)).toEqual(FILES);
    expect(START_PAGES.map((entry) => entry.file)).toEqual(expect.arrayContaining(['npm.html', 'python.html', 'bots.html']));
    expect(SITE_PAGES.map((entry) => entry.file)).toEqual(PAGES);
    expect(FILES).not.toContain(VERSIONS_PAGE.file);
    for (const name of PAGES) expect(page(name), name).not.toContain(`href="${VERSIONS_PAGE.file}"`);
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

  it('serves site/favicon.svg as favicon.svg, an image that loads and runs nothing', () => {
    const icon = readFileSync(new URL('site/favicon.svg', ROOT));
    expect(readFileSync(join(site, 'favicon.svg')).equals(icon)).toBe(true);
    const svg = icon.toString('utf8');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
    expect(svg).not.toMatch(/<script|<foreignObject|href=|@import|\son\w+=/iu);
    for (const reference of svg.matchAll(/url\(([^)]*)\)/gu)) expect(reference[1]).toMatch(/^#[\w-]+$/u);
  });

  it.each(PAGES)('%s is a complete HTML page with one h1, the icon in the header and the navigation', (name) => {
    const html = page(name);
    checkDocument(html, name);
    expect(html).not.toContain('class="banner"');
    for (const other of PAGES) expect(html, `${name} links to ${other}`).toContain(`href="${other}"`);
    expect(html).toContain(`href="${name}" aria-current="page"`);
  });

  it.each(PAGES)('%s resolves every internal link and anchor, with relative paths only', (name) => {
    checkLinks(site, name, FILES);
  });

  it.each(PAGES)('%s loads nothing but the stylesheet and the icon of the site: no scripts, frames, other images or external URLs outside links', (name) => {
    checkLoadsNothing(page(name), name);
  });

  it('has a stylesheet with a light and a dark color scheme that loads nothing', () => {
    const css = readFileSync(join(site, 'style.css'), 'utf8');
    expect(css).toBe(read('site/style.css'));
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toMatch(/color-scheme:\s*light dark/u);
    expect(css).not.toMatch(/url\(|@import|@font-face/u);
  });
});

/** The custom properties of the first rule for :root after `start` in the stylesheet. */
function colors(css: string, start: number): Map<string, string> {
  const block = /:root\s*\{([^}]*)\}/u.exec(css.slice(start))?.[1] ?? '';
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [match[1] ?? '', (match[2] ?? '').trim()]));
}

/** The contrast ratio of two colors #rrggbb, as WCAG 2 defines it. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((index) => {
      const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('site design (D-140)', () => {
  const css = () => read('site/style.css');

  it('takes its colors from the icon: teal as the accent and amber as the highlight', () => {
    const icon = read('site/favicon.svg');
    const light = colors(css(), 0);
    expect(light.get('--accent')).toBe('#0f766e');
    expect(light.get('--highlight')).toBe('#fbbf24');
    expect(icon).toContain('fill="#0f766e"');
    expect(icon).toContain('fill="#fbbf24"');
  });

  it.each(['light', 'dark'])('has enough contrast in the %s color scheme: 4.5:1 for text, 3:1 for focus rings and the borders of buttons', (scheme) => {
    const light = colors(css(), 0);
    const dark = new Map([...light, ...colors(css(), css().indexOf('@media (prefers-color-scheme: dark)'))]);
    const palette = scheme === 'light' ? light : dark;
    expect(dark.get('--background')).not.toBe(light.get('--background'));
    const color = (name: string) => {
      const value = palette.get(name) ?? '';
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/u);
      return value;
    };
    const text: [string, string][] = [
      ['--text', '--background'],
      ['--text', '--surface'],
      ['--text', '--code-background'],
      ['--text', '--zebra'],
      ['--text', '--table-head'],
      ['--text', '--hover'],
      ['--text', '--hero'],
      ['--text', '--hero-end'],
      ['--muted', '--background'],
      ['--muted', '--surface'],
      ['--link', '--background'],
      ['--link', '--surface'],
      ['--link', '--zebra'],
      ['--link', '--table-head'],
      ['--link', '--code-background'],
      ['--link', '--highlight-soft'],
      ['--link', '--hero'],
      ['--link-hover', '--background'],
      ['--link-hover', '--hover'],
      ['--link-hover', '--surface'],
      ['--current-text', '--current'],
      ['--button-text', '--button'],
      ['--text', '--highlight-soft'],
      ['--version-text', '--version'],
      ['--error-text', '--error'],
      ['--warning-text', '--warning'],
      ['--note-text', '--note'],
    ];
    for (const [foreground, background] of text) expect(contrast(color(foreground), color(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    for (const background of ['--background', '--surface']) expect(contrast(color('--focus'), color(background)), `--focus on ${background}`).toBeGreaterThanOrEqual(3);
    expect(contrast(color('--button'), color('--background')), '--button on --background').toBeGreaterThanOrEqual(3);
    // The borders of buttons and tool links against their own background and the hero around them (decision D-141).
    for (const background of ['--background', '--hero', '--hero-end']) expect(contrast(color('--control-border'), color(background)), `--control-border on ${background}`).toBeGreaterThanOrEqual(3);
  });

  it('opens the navigation and the "On this page" list on narrow screens with details elements, without JavaScript', () => {
    expect(css()).toMatch(/\.menu\[open\] \+ \.groups\s*\{/u);
    expect(css()).toMatch(/\.toc-toggle\[open\] \+ \.toc\s*\{/u);
    // Only below the widths at which the navigation and the list are always shown, so that widening the window does
    // not keep their narrow layout (decision D-141).
    const narrow = (width: string, selector: RegExp) => {
      const start = css().indexOf(`@media not all and (min-width: ${width})`);
      expect(start, width).toBeGreaterThan(-1);
      const block = css().slice(start, css().indexOf('\n}\n', start));
      expect(block).toMatch(selector);
    };
    narrow('60rem', /\.menu\[open\] \+ \.groups\s*\{/u);
    narrow('78rem', /\.toc-toggle\[open\] \+ \.toc\s*\{/u);
    expect(css()).toContain(':focus-visible');
    expect(css()).toContain('.skip:focus');
  });
});

describe('navigation in groups (D-140)', () => {
  it('puts every page in exactly one group, and the navigation follows the groups', () => {
    const grouped = PAGE_GROUPS.flatMap((group) => group.files);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(PAGE_GROUPS.map((group) => group.title)).toEqual(['Start', 'Reference', 'Integrations', 'Project']);
    expect(PAGE_GROUPS[0]?.files).toEqual(['index.html', ...START_PAGES.map((entry) => entry.file)]);
    expect(PAGE_GROUPS.at(-1)?.files).toEqual(['about.html', VERSIONS_PAGE.file]);
    expect([...SITE_PAGES, VERSIONS_PAGE].map((entry) => entry.file).sort()).toEqual([...grouped].sort());
    expect(SITE_PAGES.map((entry) => entry.file)).toEqual(grouped.filter((file) => file !== VERSIONS_PAGE.file));
  });

  it('stops the build for a page without a group', () => {
    const page = { file: 'cargo.html', nav: 'Rust', title: 'Start with Cargo', summary: 'Cargo.' };
    expect(() => groupPages([...SITE_PAGES, page])).toThrow('site: cargo.html has no group in PAGE_GROUPS in scripts/site/build.ts');
    expect(groupPages(SITE_PAGES).map((group) => group.title)).toEqual(['Start', 'Reference', 'Integrations', 'Project']);
  });

  it.each(PAGES)('%s shows the pages in their groups', (name) => {
    expect(navigation(page(name))).toEqual(
      PAGE_GROUPS.map((group) => ({ group: group.title, links: group.files.filter((file) => file !== VERSIONS_PAGE.file) })),
    );
  });

  it.each(PAGES)('%s shows the version in the top bar', (name) => {
    expect(page(name)).toContain(`<span class="version">v${manifest.version}</span>`);
  });
});

describe('hero of the start page (D-140)', () => {
  const hero = () => /<div class="hero">\n([\s\S]*?)\n<\/div>\n/u.exec(page('index.html'))?.[1] ?? '';

  it('shows the icon, the name and the introduction of the README above the README text', () => {
    const intro = splitSections(freshReadme()).sections[0];
    expect(intro?.id).toBe('depcurfew');
    expect(hero()).toContain('<img class="logo" src="favicon.svg" alt="" width="96" height="96">');
    expect(hero()).toContain('<h1 id="depcurfew">depcurfew</h1>');
    for (const line of intro?.body.split('\n').filter((text) => text.trim() !== '') ?? []) expect(hero()).toContain(escapeHtml(line));
    const html = page('index.html');
    expect(html.indexOf('<div class="hero">')).toBeLessThan(html.indexOf('<h2 id="why">'));
  });

  it('has the buttons to the five-minute start, the repository and the npm package', () => {
    expect(hero()).toContain(
      [
        '<p class="actions">',
        '<a class="button primary" href="#five-minute-start">Start in five minutes</a>',
        `<a class="button" href="${repositoryUrl(manifest.repository) ?? ''}">GitHub</a>`,
        `<a class="button" href="https://www.npmjs.com/package/${manifest.name}">npm</a>`,
        '</p>',
      ].join('\n'),
    );
    expect(manifest.name).toBe('depcurfew');
  });

  it('lists every tool of the knowledge base as a chip linking to the start page of its group', () => {
    const chips = [...hero().matchAll(/<li><a href="([^"]*)">([^<]*)<\/a><\/li>/gu)].map((match) => [match[1], match[2]]);
    expect(chips).toEqual(knowledgeBase.map((tool) => [START_PAGES.find((entry) => entry.tools.includes(tool.id))?.file, escapeHtml(tool.name)]));
    expect(hero()).toContain('<ul class="chips" aria-label="Supported tools">');
  });

  it.each(PAGES.filter((name) => name !== 'index.html'))('%s has no hero', (name) => {
    expect(page(name)).not.toContain('class="hero"');
  });
});

describe('"On this page" (D-140)', () => {
  /** The h2 and h3 headings of the content, after the list. */
  const headings = (html: string) => [...html.slice(html.indexOf('<div class="content">')).matchAll(/<h([23]) id="([^"]*)">/gu)].map((match) => ({ level: Number(match[1]), id: match[2] ?? '' }));

  it.each(PAGES)('%s lists its h2 headings when it has two or more, and the h3 headings too when it has at most six', (name) => {
    const html = page(name);
    const all = headings(html);
    const h2 = all.filter((heading) => heading.level === 2);
    if (h2.length < 2) {
      expect(onThisPage(html)).toBeUndefined();
      return;
    }
    expect(onThisPage(html)).toEqual((all.length - h2.length <= 6 ? all : h2).map((heading) => heading.id));
  });

  it('lists every doctor rule, the h2 sections of the knowledge base without their h3 headings, and the rules of a start page', () => {
    expect(onThisPage(page('doctor.html'))).toEqual(RULES.map((rule) => rule.id));
    expect(page('doctor.html')).toContain(`<li><a href="#${RULES[0]?.id ?? ''}"><code>${RULES[0]?.id ?? ''}</code></a></li>`);
    const knowledge = onThisPage(page('knowledge.html')) ?? [];
    expect(knowledge).toContain('release-age-cooldown');
    expect(knowledge).not.toContain('npm');
    expect(onThisPage(page('python.html'))).toEqual(expect.arrayContaining(['python-projects', 'python-config-ignored', 'lockfile-out-of-date']));
    expect(onThisPage(page('codes.html'))).toEqual(['init-warnings-and-notes', 'apply-warnings-and-errors']);
    expect(onThisPage(page('commands.html'))).toBeUndefined();
  });
});

describe('levels as pills (D-140)', () => {
  it('shows the level of each doctor rule and doctor --user rule as a pill with its word', () => {
    for (const [name, rules] of [['doctor.html', RULES], ['machine.html', USER_RULES]] as const) {
      for (const rule of rules) {
        expect(page(name), rule.id).toMatch(new RegExp(`<h\\d id="${rule.id}"><code>${rule.id}</code></h\\d>\\n<p><strong class="level level-${rule.level}">${rule.level}</strong> · `, 'u'));
      }
    }
    // The rules on the start pages, too.
    for (const start of START_PAGES) {
      for (const rule of RULES.filter((entry) => page(start.file).includes(`<h3 id="${entry.id}">`))) {
        expect(page(start.file), rule.id).toMatch(new RegExp(`<h3 id="${rule.id}"><code>${rule.id}</code></h3>\\n<p><strong class="level level-${rule.level}">${rule.level}</strong> · `, 'u'));
      }
    }
    expect(page('php.html')).toContain('<h3 id="composer-config-weakens">');
  });

  it('shows the level of each code of init and apply as a pill with its word', () => {
    const html = page('codes.html');
    const lists: [Record<string, string>, string][] = [
      [INIT_WARNINGS, 'warning'],
      [INIT_NOTES, 'note'],
      [APPLY_WARNINGS, 'warning'],
      [APPLY_ERRORS, 'error'],
    ];
    for (const [codes, level] of lists) for (const code of Object.keys(codes)) expect(html, code).toContain(`<li><span class="level level-${level}">${level}</span> <code>${code}</code>: `);
    expect(html.match(/<span class="level /gu)).toHaveLength(lists.reduce((sum, [codes]) => sum + Object.keys(codes).length, 0));
    for (const label of ['Warnings:', 'Notes:', 'Errors (nothing is written):']) expect(html, label).toContain(`<p>${label}</p>\n<ul class="codes">\n<li><span class="level `);
  });

  it.each(PAGES)('%s writes every level word in bold as a pill', (name) => {
    expect(page(name)).not.toMatch(/<strong>(error|warning|note)<\/strong>/u);
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

  it('lists every other page on the start page, in the groups of the navigation', () => {
    const html = page('index.html');
    const list = html.slice(html.indexOf('<h2 id="on-this-site">On this site</h2>'));
    expect(list).not.toBe('');
    for (const entry of SITE_PAGES.filter((other) => other.file !== 'index.html')) {
      expect(list).toContain(`<li><a href="${entry.file}"><span class="title">${escapeHtml(entry.title)}</span><span class="visually-hidden">:</span> <span class="summary">${escapeHtml(entry.summary)}</span></a></li>`);
    }
    const groups = [...list.matchAll(/<h3 id="([^"]*)">([^<]*)<\/h3>\n<ul class="cards">/gu)].map((match) => [match[1], match[2]]);
    expect(groups).toEqual(PAGE_GROUPS.map((group) => [group.title.toLowerCase(), group.title]));
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
