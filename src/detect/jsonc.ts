/** The index of the first character from `from` on that is neither whitespace nor inside a comment. */
export function nextSignificant(text: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < text.length && /\s/u.test(text[index] as string)) index += 1;
    if (text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return text.length;
      index = end + 2;
    } else {
      return index;
    }
  }
}

/** Parses JSON that may contain comments and trailing commas (JSONC), as used by deno.json and deno.jsonc. */
export function parseJsonc(text: string): unknown {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
      output += text.slice(start, index);
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('unterminated block comment');
      // Keep line breaks so that positions in error messages stay meaningful.
      output += text.slice(index, end + 2).replace(/[^\n]/gu, ' ');
      index = end + 2;
    } else if (char === ',') {
      // A trailing comma (outside strings, before a closing bracket) becomes a space, keeping positions.
      const following = text[nextSignificant(text, index + 1)];
      output += following === '}' || following === ']' ? ' ' : ',';
      index += 1;
    } else {
      output += char;
      index += 1;
    }
  }
  return JSON.parse(output);
}
