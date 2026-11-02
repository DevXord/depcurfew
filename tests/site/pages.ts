// Checks shared by the tests of the documentation site (decisions D-132, D-139 and D-140): every page is a complete
// HTML document with one h1, the top bar with the icon and the version, and the navigation right after the toggle that
// opens it on narrow screens; every internal link and anchor resolves with a relative path, and nothing is loaded
// from another host.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { expect } from 'vitest';

/**
 * The first 12 hexadecimal digits of the SHA-256 of site/style.css, which every page puts in the address of the
 * stylesheet, so that a browser fetches a changed stylesheet instead of a cached one (decision D-147).
 */
export const STYLE_STAMP = createHash('sha256').update(readFileSync(new URL('../../site/style.css', import.meta.url))).digest('hex').slice(0, 12);

/** The files under a directory, as paths with `/`. */
export function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

export const readPage = (directory: string, name: string) => readFileSync(join(directory, ...name.split('/')), 'utf8');

/** Every attribute value of the page with the element it is on. */
export function attributes(html: string): { tag: string; name: string; value: string }[] {
  const found: { tag: string; name: string; value: string }[] = [];
  for (const element of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/gu)) {
    const [, tag = '', rest = ''] = element;
    for (const attribute of rest.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/gu)) found.push({ tag: tag.toLowerCase(), name: (attribute[1] ?? '').toLowerCase(), value: attribute[2] ?? '' });
  }
  return found;
}

export const unescape = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
export const ids = (html: string) => [...html.matchAll(/\sid="([^"]*)"/gu)].map((match) => unescape(match[1] ?? ''));
export const isExternal = (value: string) => /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith('//');

/** The relative path from a page to the root of the site: empty at the root, `../` in a version directory. */
export const rootOf = (name: string) => '../'.repeat(name.split('/').length - 1);

/** The stylesheet and the icon, the only elements that load something, as the template writes them. */
export const loads = (name: string) => {
  const root = rootOf(name);
  return {
    stylesheet: `<link rel="stylesheet" href="${root}style.css?v=${STYLE_STAMP}">`,
    icon: `<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">`,
    brand: `<a class="brand" href="${root}index.html"><img src="${root}favicon.svg" alt="" width="20" height="20">depcurfew</a>`,
    image: `<img src="${root}favicon.svg" alt="" width="20" height="20">`,
    // The large icon of the hero, on the start page of the current version only (D-140).
    logo: `<img class="logo" src="${root}favicon.svg" alt="" width="96" height="96">`,
  };
};

/** The images of a page: the icon in the top bar, and on the start page of the current version the icon of the hero. */
export const images = (name: string) => (name === 'index.html' ? [loads(name).image, loads(name).logo] : [loads(name).image]);

/** The navigation of a page: each group title with the links under it, in order. */
export function navigation(html: string): { group: string; links: string[] }[] {
  const nav = /<nav class="pages" aria-label="Pages">\n([\s\S]*?)\n<\/nav>/u.exec(html)?.[1] ?? '';
  return [...nav.matchAll(/<div class="group">\n<p class="group-title">([^<]*)<\/p>\n<ul>\n([\s\S]*?)\n<\/ul>\n<\/div>/gu)].map((match) => ({
    group: unescape(match[1] ?? ''),
    links: [...(match[2] ?? '').matchAll(/<a href="([^"]*)"/gu)].map((link) => unescape(link[1] ?? '')),
  }));
}

/** The "On this page" list of a page: the anchors it links to, or undefined when the page has none. */
export function onThisPage(html: string): string[] | undefined {
  const list = /<nav class="toc" aria-label="On this page">\n([\s\S]*?)\n<\/nav>/u.exec(html)?.[1];
  return list === undefined ? undefined : [...list.matchAll(/<a href="#([^"]*)">/gu)].map((match) => decodeURIComponent(unescape(match[1] ?? '')));
}

/**
 * A complete HTML page with one h1, the icon, depcurfew and the version in the top bar, the stylesheet, and the
 * navigation with the details element that opens it on narrow screens as its first child, as site/style.css expects
 * (decisions D-140 and D-141).
 */
export function checkDocument(html: string, name: string): void {
  const expected = loads(name);
  expect(html.startsWith('<!doctype html>\n<html lang="en">\n'), name).toBe(true);
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  expect(html).toContain(expected.stylesheet);
  expect(html).toContain(expected.icon);
  expect(html.match(/<a class="brand"[^>]*>.*?<\/a>/gu), name).toEqual([expected.brand]);
  expect(html, name).toMatch(/<header class="site">\n<a class="brand"[^\n]*<\/a>\n<span class="version">v\d+\.\d+\.\d+<\/span>\n<\/header>\n/u);
  expect(html, name).toContain('<a class="skip" href="#content">Skip to content</a>');
  // The toggle is the first child of the navigation, inside its landmark (decision D-141).
  expect(html, name).toContain('<nav class="pages" aria-label="Pages">\n<details class="menu"><summary>Menu</summary></details>\n<div class="groups">\n');
  expect(navigation(html).length, name).toBeGreaterThan(1);
  expect(html, name).toContain('<main id="content">\n');
  // The list of the page's headings follows the toggle that opens it on narrow screens.
  if (onThisPage(html) !== undefined) expect(html, name).toContain('<details class="toc-toggle"><summary>On this page</summary></details>\n<nav class="toc" aria-label="On this page">\n');
  else expect(html, name).not.toContain('toc-toggle');
  expect(html).toMatch(/<title>[^<]+<\/title>/u);
  expect(html.match(/<h1[ >]/gu)?.length, name).toBe(1);
  expect(html).not.toMatch(/\{\{\w+\}\}/u);
}

/** Every internal link and anchor of the page resolves among `all`, the files of the site, with relative paths only. */
export function checkLinks(directory: string, name: string, all: readonly string[]): void {
  const html = readPage(directory, name);
  const own = new Set(ids(html));
  expect(own.size, `${name}: duplicate ids`).toBe(ids(html).length);
  for (const { name: attribute, value: raw } of attributes(html)) {
    if (!['href', 'src', 'srcset', 'action', 'poster', 'data', 'formaction'].includes(attribute)) continue;
    const value = unescape(raw);
    if (isExternal(value)) continue;
    expect(value.startsWith('/'), `${name}: ${value} is not relative`).toBe(false);
    const [address = '', fragment] = value.split('#');
    // A static server ignores the query, such as the stamp in the address of the stylesheet (decision D-147).
    const path = address.split('?')[0] ?? '';
    const target = path === '' ? name : posix.normalize(posix.join(posix.dirname(name), path));
    expect(all, `${name}: ${value}`).toContain(target);
    if (fragment !== undefined) {
      const targetIds = target === name ? own : new Set(ids(readPage(directory, target)));
      expect(targetIds.has(decodeURIComponent(fragment)), `${name}: ${value} has no anchor`).toBe(true);
    }
  }
}

/**
 * The page loads nothing from elsewhere: no scripts, frames, forms or styles, external URLs only in links, and the only
 * elements that load something are the stylesheet, the icon, the icon in the top bar and, on the start page, the icon
 * of the hero, all of this site.
 */
export function checkLoadsNothing(html: string, name: string): void {
  const expected = loads(name);
  expect(html).not.toMatch(/<(script|iframe|object|embed|video|audio|source|picture|form|base|svg|meta http-equiv)\b/iu);
  expect(html).not.toMatch(/\sstyle="/u);
  expect(html).not.toMatch(/\son\w+="/u);
  for (const { tag, name: attribute, value } of attributes(html)) {
    if (tag === 'a' && attribute === 'href') {
      if (isExternal(unescape(value))) expect(unescape(value), name).toMatch(/^(https?|mailto):/u);
      continue;
    }
    expect(isExternal(unescape(value)), `${name}: <${tag} ${attribute}="${value}">`).toBe(false);
  }
  expect(html.match(/<link\b[^>]*>/gu), name).toEqual([expected.stylesheet, expected.icon]);
  expect(html.match(/<img\b[^>]*>/gu), name).toEqual(images(name));
}
