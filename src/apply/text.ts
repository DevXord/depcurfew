// Editors work on text with LF line endings and no byte order mark; the original style is restored on write.
import { myers } from './diff.ts';

export interface TextStyle {
  eol: '\n' | '\r\n';
  bom: boolean;
  finalNewline: boolean;
}

export function detectStyle(text: string): TextStyle {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  return {
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    bom: text.startsWith('﻿'),
    finalNewline: body === '' || body.endsWith('\n'),
  };
}

export function toLf(text: string): string {
  return (text.startsWith('﻿') ? text.slice(1) : text).replaceAll('\r\n', '\n');
}

/**
 * The edited text in the style of the original. A file with both CRLF and LF line endings keeps the ending of every
 * line apply did not change (`original` is needed for that); a changed line takes the ending of the line it
 * replaces, a new line the ending of the line before it.
 */
export function restoreStyle(body: string, style: TextStyle, original?: string): string {
  if (original !== undefined && isMixed(original)) return withMixedEndings(body, style, original);
  let text = style.finalNewline || !body.endsWith('\n') ? body : body.slice(0, -1);
  if (style.eol === '\r\n') text = text.replaceAll('\n', '\r\n');
  return style.bom ? `﻿${text}` : text;
}

/** Whether a text has CRLF and LF line endings both. */
function isMixed(text: string): boolean {
  return text.includes('\r\n') && /(?:^|[^\r])\n/u.test(text);
}

function withMixedEndings(body: string, style: TextStyle, original: string): string {
  const old = (style.bom ? original.slice(1) : original).split(/(?<=\n)/u);
  const ending = (line: string | undefined) => (line?.endsWith('\r\n') === true ? '\r\n' : line?.endsWith('\n') === true ? '\n' : '');
  const lines = body.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const output: string[] = [];
  // A run of changed lines: the endings of the lines it removes go to the lines it adds, in order.
  let added: string[] = [];
  let removed: string[] = [];
  const add = (line: string, own: string | undefined) => {
    const previous = output.at(-1);
    // The last line of a file without a final newline has no ending of its own.
    output.push(`${line}${own === undefined || own === '' ? (previous === undefined ? style.eol : ending(previous)) : own}`);
  };
  const flush = () => {
    added.forEach((line, index) => add(line, removed[index]));
    added = [];
    removed = [];
  };
  let next = 0;
  for (const operation of myers(old.map((line) => line.slice(0, line.length - ending(line).length)), lines)) {
    if (operation.kind === 'insert') {
      added.push(operation.line);
      continue;
    }
    const own = ending(old[next]);
    next += 1;
    if (operation.kind === 'delete') {
      removed.push(own);
      continue;
    }
    flush();
    add(operation.line, own);
  }
  flush();
  let text = output.join('');
  if (!style.finalNewline) text = text.replace(/\r?\n$/u, '');
  return style.bom ? `﻿${text}` : text;
}
