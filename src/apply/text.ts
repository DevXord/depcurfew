// Editors work on text with LF line endings and no byte order mark; the original style is restored on write.

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

export function restoreStyle(body: string, style: TextStyle): string {
  let text = style.finalNewline || !body.endsWith('\n') ? body : body.slice(0, -1);
  if (style.eol === '\r\n') text = text.replaceAll('\n', '\r\n');
  return style.bom ? `﻿${text}` : text;
}
