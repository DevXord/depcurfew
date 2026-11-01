// Positions that parsers give only in their messages, for the locations of findings (decision D-116).

/**
 * Where a parser says the error is, from its message: the yaml package and depcurfew's own checks write "at line 3,
 * column 1", the TOML reader "at line 4", V8's JSON.parse "(line 2 column 5)". The location gets it, so that SARIF and
 * the annotations point at the line (decision D-116); undefined when the message names none.
 */
export function positionInMessage(message: string): { line: number; column?: number } | undefined {
  const match = /\bat line (\d+)(?:, column (\d+))?/u.exec(message) ?? /\(line (\d+) column (\d+)\)/u.exec(message);
  if (match === null) return undefined;
  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  return column === undefined || !Number.isSafeInteger(column) || column < 1 ? { line } : { line, column };
}
