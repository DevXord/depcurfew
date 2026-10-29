// ANSI colors for text meant for people. They are used only on a terminal: NO_COLOR (https://no-color.org) turns
// them off and FORCE_COLOR turns them on, for example in CI logs that show colors. JSON, SARIF, a diff written to
// a file and anything else read by a program stay plain, because nothing but a terminal gets colors by default.

export interface Paint {
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

const CODES = { red: [31, 39], yellow: [33, 39], green: [32, 39], cyan: [36, 39], bold: [1, 22], dim: [2, 22] } as const;

const style =
  ([open, close]: readonly [number, number]) =>
  (text: string): string =>
    text === '' ? text : `\u001b[${open}m${text}\u001b[${close}m`;
const same = (text: string): string => text;

export const PLAIN: Paint = { red: same, yellow: same, green: same, cyan: same, bold: same, dim: same };
export const COLORED: Paint = {
  red: style(CODES.red),
  yellow: style(CODES.yellow),
  green: style(CODES.green),
  cyan: style(CODES.cyan),
  bold: style(CODES.bold),
  dim: style(CODES.dim),
};

export function paint(colors: boolean | undefined): Paint {
  return colors === true ? COLORED : PLAIN;
}

/**
 * Whether to color a stream. FORCE_COLOR wins (any value but "0" or "false" turns colors on, those two turn them
 * off), then NO_COLOR with any non-empty value turns them off; otherwise only a terminal that is not "dumb" gets them.
 */
export function colorsFor(stream: { isTTY?: boolean }, env: Readonly<Record<string, string | undefined>>): boolean {
  const force = env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  if ((env['NO_COLOR'] ?? '') !== '') return false;
  return stream.isTTY === true && env['TERM'] !== 'dumb';
}

/** Colors the prefix of diagnostic lines on stderr: "depgate:" and "error:" red, "warning:" yellow. */
export function paintDiagnostics(text: string, colors: Paint): string {
  return text.replace(/^(depgate:|error:|warning:)/gmu, (prefix) => (prefix === 'warning:' ? colors.yellow(prefix) : colors.red(colors.bold(prefix))));
}
