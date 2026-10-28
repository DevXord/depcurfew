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
    } else {
      output += char;
      index += 1;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, '$1'));
}
