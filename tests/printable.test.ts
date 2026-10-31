import { describe, expect, it } from 'vitest';
import { printable, redactCredentials, withoutCredentials } from '../src/printable.ts';

describe('printable', () => {
  it('writes ESC, BEL, CR, LF and other C0 controls as \\xHH', () => {
    expect(printable('\u001b]8;;http://evil.example/\u0007lodash\u001b]8;;\u0007')).toBe('\\x1b]8;;http://evil.example/\\x07lodash\\x1b]8;;\\x07');
    expect(printable('a\r\u001b[2Kb\nc\u0000')).toBe('a\\x0d\\x1b[2Kb\\x0ac\\x00');
  });

  it('writes DEL and C1 controls as \\xHH', () => {
    expect(printable('a\u007fb\u0080c\u009bd\u009f')).toBe('a\\x7fb\\x80c\\x9bd\\x9f');
  });

  it('keeps tabs, printable ASCII and other Unicode text', () => {
    expect(printable('name\tvalue zażółć 100% ~ \u00a0é 日本')).toBe('name\tvalue zażółć 100% ~ \u00a0é 日本');
  });

  it('writes the bidirectional controls as \\uHHHH, so that text cannot be shown reordered (Trojan Source)', () => {
    expect(printable('evil\u202egnp.')).toBe('evil\\u202egnp.');
    expect(printable('\u2066a\u2069 \u200e\u200f\u061c\u202a\u202d')).toBe('\\u2066a\\u2069 \\u200e\\u200f\\u061c\\u202a\\u202d');
  });

  it('keeps line feeds only when asked to', () => {
    expect(printable('one\ntwo\r\n\u001b', { lines: true })).toBe('one\ntwo\\x0d\n\\x1b');
  });
});

describe('redactCredentials', () => {
  it('shows the user and password of a URL as <redacted>, also a password with an unencoded @, and a token alone', () => {
    expect(redactCredentials('find-links = "https://bob:ghp_TOKEN@host.example.com/links"')).toBe('find-links = "https://<redacted>@host.example.com/links"');
    expect(redactCredentials('https://ada:p@ss@npm.example.com/ and https://npm_TOKEN@r.example.com/')).toBe('https://<redacted>@npm.example.com/ and https://<redacted>@r.example.com/');
    expect(redactCredentials('https://registry.npmjs.org/')).toBe('https://registry.npmjs.org/');
  });

  it('leaves withoutCredentials, for URLs depcurfew sends, as it was', () => {
    expect(withoutCredentials('https://bob:ghp_TOKEN@host.example.com/links')).toBe('https://host.example.com/links');
  });
});
