// A Markdown renderer for exactly the subset README.md and docs/knowledge.md use (decision D-132): ATX headings with
// GitHub ids, paragraphs, bullet and ordered lists without nesting, GitHub tables, fenced code blocks, code spans,
// links and autolinks, strong and emphasis with stars, backslash escapes and <br>. HTML comments are dropped; any other HTML,
// images and entities are escaped and shown as text. Link targets with a scheme other than http, https and mailto
// lose their link.

export interface Heading {
  level: number;
  id: string;
  /** The heading as plain text. */
  text: string;
}

export interface MarkdownOptions {
  /** The id of a heading from its plain text; GitHub ids, numbered when repeated, by default. */
  slug?: (text: string) => string;
  /** Rewrites a link target before it is written. */
  href?: (target: string) => string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

export interface Section {
  level: number;
  /** The Markdown of the heading, without the hashes. */
  heading: string;
  /** The heading as plain text. */
  text: string;
  /** The GitHub id of the heading in the whole document. */
  id: string;
  /** The Markdown under the heading up to the next heading of any level, each line ending in a newline. */
  body: string;
}

type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'break' }
  | { kind: 'link'; target: string; children: Inline[] }
  | { kind: 'strong' | 'em'; children: Inline[] };

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** The id GitHub gives a heading: lower case, without punctuation and symbols, spaces as hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‍︀-️]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

/** A slug function that numbers repeated ids as GitHub does (`npm`, `npm-1`), never giving a reserved one. */
export function createSlugger(reserved: Iterable<string> = []): (text: string) => string {
  const used = new Set(reserved);
  return (text) => {
    const base = slugify(text) || 'section';
    let id = base;
    for (let count = 1; used.has(id); count += 1) id = `${base}-${count}`;
    used.add(id);
    return id;
  };
}

// Blocks.

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const BULLET = /^ {0,3}([-*+])[ \t]+(.*)$/u;
const ORDERED = /^ {0,3}(\d{1,9})([.)])[ \t]+(.*)$/u;
const COMMENT = /^ {0,3}<!--/u;
const DELIMITER_CELL = /^:?-+:?$/u;

function lines(markdown: string): string[] {
  const all = markdown.replaceAll('\r\n', '\n').split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
}

const isBlank = (line: string) => line.trim() === '';

/** The cells of a table row: split at pipes that are not escaped, with the outer pipes removed. */
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const result: string[] = [];
  let current = '';
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index] ?? '';
    if (char === '\\' && row[index + 1] === '|') {
      current += '\\|';
      index += 1;
    } else if (char === '|') {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map((cell) => cell.trim());
}

/** The alignments of a delimiter row, or undefined when the line is none for a header of `count` cells. */
function delimiterRow(line: string | undefined, count: number): ('left' | 'center' | 'right' | undefined)[] | undefined {
  if (line === undefined || !line.includes('-')) return undefined;
  const row = cells(line);
  if (row.length !== count || !row.every((cell) => DELIMITER_CELL.test(cell))) return undefined;
  return row.map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined));
}

function startsTable(all: readonly string[], index: number): boolean {
  const line = all[index] ?? '';
  return line.includes('|') && delimiterRow(all[index + 1], cells(line).length) !== undefined;
}

/** Whether a line starts a block that ends a paragraph or a list item. */
function startsBlock(all: readonly string[], index: number): boolean {
  const line = all[index] ?? '';
  return HEADING.test(line) || FENCE.test(line) || COMMENT.test(line) || BULLET.test(line) || ORDERED.test(line) || startsTable(all, index);
}

export function renderMarkdown(markdown: string, options: MarkdownOptions = {}): Rendered {
  const slug = options.slug ?? createSlugger();
  const rewrite = options.href ?? ((target: string) => target);
  const inline = (source: string) => renderInline(parseInline(source), rewrite);
  const all = lines(markdown);
  const out: string[] = [];
  const headings: Heading[] = [];
  let index = 0;
  while (index < all.length) {
    const line = all[index] ?? '';
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    if (COMMENT.test(line)) {
      while (index < all.length && !(all[index] ?? '').includes('-->')) index += 1;
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null && !(fence[2]?.startsWith('`') === true && fence[3]?.includes('`') === true)) {
      const [, indent = '', marker = '', info = ''] = fence;
      const content: string[] = [];
      index += 1;
      while (index < all.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(all[index] ?? '');
        if (close !== null && close[1]?.[0] === marker[0] && (close[1]?.length ?? 0) >= marker.length) break;
        const text = all[index] ?? '';
        content.push(text.startsWith(indent) ? text.slice(indent.length) : text.trimStart());
        index += 1;
      }
      index += 1;
      const language = info.trim().split(/\s+/u)[0] ?? '';
      const attribute = /^[\w+-]+$/u.test(language) ? ` class="language-${language}"` : '';
      out.push(`<pre><code${attribute}>${content.map((text) => `${escapeHtml(text)}\n`).join('')}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const nodes = parseInline((heading[2] ?? '').trim());
      const text = plainText(nodes);
      const id = slug(text);
      headings.push({ level, id, text });
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(nodes, rewrite)}</h${level}>`);
      index += 1;
      continue;
    }
    if (startsTable(all, index)) {
      const header = cells(line);
      const align = delimiterRow(all[index + 1], header.length) ?? [];
      const row = (values: readonly string[], tag: 'th' | 'td') =>
        `<tr>${header
          .map((_, column) => {
            const side = align[column];
            const text = (values[column] ?? '').replaceAll('\\|', '|');
            return `<${tag}${side === undefined ? '' : ` class="align-${side}"`}>${inline(text)}</${tag}>`;
          })
          .join('')}</tr>`;
      const body: string[] = [];
      index += 2;
      while (index < all.length && !isBlank(all[index] ?? '') && !startsBlock(all, index)) {
        body.push(row(cells(all[index] ?? ''), 'td'));
        index += 1;
      }
      out.push(
        [
          '<div class="table"><table>',
          '<thead>',
          row(header, 'th'),
          '</thead>',
          ...(body.length === 0 ? [] : ['<tbody>', ...body, '</tbody>']),
          '</table></div>',
        ].join('\n'),
      );
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      // The marker that continues the list: the same bullet character, or the same delimiter after a number.
      const marker = bullet !== null ? bullet[1] : ordered?.[2];
      const items: string[] = [];
      while (index < all.length) {
        const item = bullet !== null ? BULLET.exec(all[index] ?? '') : ORDERED.exec(all[index] ?? '');
        if (item === null || (bullet !== null ? item[1] : item[2]) !== marker) break;
        const text = [(bullet !== null ? item[2] : item[3]) ?? ''];
        index += 1;
        while (index < all.length && !isBlank(all[index] ?? '') && !startsBlock(all, index)) {
          text.push((all[index] ?? '').trim());
          index += 1;
        }
        items.push(`<li>${inline(text.join('\n').trim())}</li>`);
      }
      const start = ordered === null ? 1 : Number(ordered[1]);
      const tag = bullet !== null ? 'ul' : 'ol';
      out.push([`<${tag}${tag === 'ol' && start !== 1 ? ` start="${start}"` : ''}>`, ...items, `</${tag}>`].join('\n'));
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < all.length && !isBlank(all[index] ?? '') && !startsBlock(all, index)) {
      paragraph.push((all[index] ?? '').trim());
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  return { html: out.map((block) => `${block}\n`).join(''), headings };
}

/** A document split at its headings (outside code blocks and comments), with GitHub ids. */
export function splitSections(markdown: string): { preamble: string; sections: Section[] } {
  const slug = createSlugger();
  const all = lines(markdown);
  const preamble: string[] = [];
  const sections: Section[] = [];
  let fence: string | undefined;
  let comment = false;
  for (const line of all) {
    const current = sections.at(-1);
    const add = () => {
      if (current === undefined) preamble.push(line);
      else current.body += `${line}\n`;
    };
    if (fence !== undefined) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
      if (close !== null && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length) fence = undefined;
      add();
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      add();
      continue;
    }
    const open = FENCE.exec(line);
    if (open !== null && !(open[2]?.startsWith('`') === true && open[3]?.includes('`') === true)) {
      fence = open[2];
      add();
      continue;
    }
    if (COMMENT.test(line)) {
      comment = !line.includes('-->');
      add();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading === null) {
      add();
      continue;
    }
    const source = (heading[2] ?? '').trim();
    const text = plainText(parseInline(source));
    sections.push({ level: heading[1]?.length ?? 1, heading: source, text, id: slug(text), body: '' });
  }
  return { preamble: preamble.map((line) => `${line}\n`).join(''), sections };
}

// Inlines.

const PUNCTUATION = /[!-/:-@[-`{-~]/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** The end (exclusive) of the code span opening at `start`, or -1 when no run of the same length closes it. */
function codeSpanEnd(source: string, start: number): { length: number; end: number } {
  let length = 0;
  while (source[start + length] === '`') length += 1;
  let search = start + length;
  while (search < source.length) {
    const next = source.indexOf('`', search);
    if (next === -1) break;
    let run = 0;
    while (source[next + run] === '`') run += 1;
    if (run === length) return { length, end: next + run };
    search = next + run;
  }
  return { length, end: -1 };
}

/** The index of the bracket closing the one at `start`, skipping code spans and escapes, or -1. */
function closingBracket(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') index += 1;
    else if (char === '`') {
      const span = codeSpanEnd(source, index);
      index = span.end === -1 ? index + span.length - 1 : span.end - 1;
    } else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** A link at `start` (`[text](target "title")`): its text, target and end, or undefined. */
function linkAt(source: string, start: number): { text: string; target: string; end: number } | undefined {
  const close = closingBracket(source, start);
  if (close === -1 || source[close + 1] !== '(') return undefined;
  let index = close + 2;
  let depth = 0;
  let target = '';
  for (; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '\\' && PUNCTUATION.test(source[index + 1] ?? '')) {
      target += source[index + 1];
      index += 1;
    } else if (char === '(') {
      depth += 1;
      target += char;
    } else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
      target += char;
    } else if (/\s/u.test(char)) break;
    else target += char;
  }
  const title = /^\s+(?:"[^"]*"|'[^']*')\s*\)/u.exec(source.slice(index));
  if (title !== null) index += title[0].length - 1;
  if (source[index] !== ')' || target === '') return undefined;
  return { text: source.slice(start + 1, close), target, end: index + 1 };
}

/** A run of `*` that may open or close emphasis, until the runs are matched. */
interface Delimiter {
  kind: 'delimiter';
  char: string;
  length: number;
  open: boolean;
  close: boolean;
}

type Token = Inline | Delimiter;

// Stricter than CommonMark, so that a star in plain text (`"*"`, `lts/*`, `package*`) stays text: a run opens before
// a letter, digit, backtick or bracket and not inside a word, and closes after a letter, digit, backtick, closing
// bracket or sentence punctuation, not before a letter or digit. Underscores are never emphasis: the documents use
// stars only, and their text has Python names such as __init__ and snake_case.
const canOpen = (before: string | undefined, after: string | undefined) => after !== undefined && /[\p{L}\p{N}`[(]/u.test(after) && (before === undefined || !ALPHANUMERIC.test(before));
const canClose = (before: string | undefined, after: string | undefined) => before !== undefined && /[\p{L}\p{N}`)\].,:;!?]/u.test(before) && (after === undefined || !ALPHANUMERIC.test(after));

/** Pairs every closing run with the nearest opening run of the same character before it, as CommonMark does. */
function emphasis(tokens: Token[]): Inline[] {
  for (let index = 0; index < tokens.length; index += 1) {
    const closer = tokens[index];
    if (closer?.kind !== 'delimiter' || !closer.close) continue;
    while (closer.length > 0) {
      let start = index - 1;
      for (; start >= 0; start -= 1) {
        const candidate = tokens[start];
        if (candidate?.kind === 'delimiter' && candidate.open && candidate.char === closer.char && candidate.length > 0) break;
      }
      const opener = tokens[start];
      if (opener?.kind !== 'delimiter') break;
      const used = opener.length >= 2 && closer.length >= 2 ? 2 : 1;
      opener.length -= used;
      closer.length -= used;
      const children = finish(tokens.slice(start + 1, index));
      tokens.splice(start + 1, index - start - 1, { kind: used === 2 ? 'strong' : 'em', children });
      index = start + 2;
    }
  }
  return finish(tokens);
}

/** Tokens as inlines: unmatched runs become text, and neighboring text is joined. */
function finish(tokens: readonly Token[]): Inline[] {
  const result: Inline[] = [];
  for (const token of tokens) {
    const node: Inline = token.kind === 'delimiter' ? { kind: 'text', value: token.char.repeat(token.length) } : token;
    const last = result.at(-1);
    if (node.kind === 'text' && node.value === '') continue;
    if (node.kind === 'text' && last?.kind === 'text') result[result.length - 1] = { kind: 'text', value: last.value + node.value };
    else result.push(node);
  }
  return result;
}

function parseInline(source: string, inLink = false): Inline[] {
  const nodes: Token[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') nodes.push({ kind: 'text', value: text });
    text = '';
  };
  for (let index = 0; index < source.length; ) {
    const char = source[index] ?? '';
    if (char === '\\' && PUNCTUATION.test(source[index + 1] ?? '')) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const span = codeSpanEnd(source, index);
      if (span.end === -1) {
        text += '`'.repeat(span.length);
        index += span.length;
        continue;
      }
      let value = source.slice(index + span.length, span.end - span.length).replaceAll('\n', ' ');
      if (value.length >= 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') value = value.slice(1, -1);
      flush();
      nodes.push({ kind: 'code', value });
      index = span.end;
      continue;
    }
    if (char === '<') {
      const lineBreak = /^<br\s*\/?>/iu.exec(source.slice(index));
      if (lineBreak !== null) {
        flush();
        nodes.push({ kind: 'break' });
        index += lineBreak[0].length;
        continue;
      }
      const autolink = /^<((?:https?|mailto):[^\s<>]+)>/iu.exec(source.slice(index));
      if (autolink !== null && !inLink) {
        flush();
        nodes.push({ kind: 'link', target: autolink[1] ?? '', children: [{ kind: 'text', value: autolink[1] ?? '' }] });
        index += autolink[0].length;
        continue;
      }
    }
    if (char === '!' && source[index + 1] === '[') {
      // Images are not supported: the whole construct is shown as text.
      const image = linkAt(source, index + 1);
      if (image !== undefined) {
        text += source.slice(index, image.end);
        index = image.end;
        continue;
      }
    }
    if (char === '[' && !inLink) {
      const link = linkAt(source, index);
      if (link !== undefined) {
        flush();
        nodes.push({ kind: 'link', target: link.target, children: parseInline(link.text, true) });
        index = link.end;
        continue;
      }
    }
    if (char === '*') {
      let length = 0;
      while (source[index + length] === char) length += 1;
      const before = source[index - 1];
      const after = source[index + length];
      flush();
      nodes.push({ kind: 'delimiter', char, length, open: canOpen(before, after), close: canClose(before, after) });
      index += length;
      continue;
    }
    text += char;
    index += 1;
  }
  flush();
  return emphasis(nodes);
}

function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.value;
        case 'break':
          return ' ';
        default:
          return plainText(node.children);
      }
    })
    .join('');
}

/**
 * A target that may become a link: a relative path or anchor, or an http, https or mailto URL. A target with a control
 * character or whitespace never does: the WHATWG URL parser strips leading C0 controls and spaces and removes tabs and
 * newlines anywhere before it reads the scheme, so "\u0001javascript:" and "java\tscript:" are javascript: there.
 */
function safeTarget(target: string): boolean {
  if (/[\u0000- \u007f-\u009f\s]/u.test(target)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(target)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function renderInline(nodes: readonly Inline[], rewrite: (target: string) => string): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return escapeHtml(node.value);
        case 'code':
          return `<code>${escapeHtml(node.value)}</code>`;
        case 'break':
          return '<br>';
        case 'strong':
          return `<strong>${renderInline(node.children, rewrite)}</strong>`;
        case 'em':
          return `<em>${renderInline(node.children, rewrite)}</em>`;
        case 'link': {
          const children = renderInline(node.children, rewrite);
          const target = rewrite(node.target);
          return safeTarget(target) ? `<a href="${escapeHtml(target)}">${children}</a>` : children;
        }
      }
    })
    .join('');
}
