// Policy durations: a whole number and one unit, e.g. "36h", "3d" or "1w". Kept in minutes, the policy's resolution.
// Converting to a tool's own unit happens in convert.ts, using units from the knowledge base.

export interface Duration {
  /** The duration as written in the policy. */
  text: string;
  minutes: number;
}

export type DurationResult = { ok: true; duration: Duration } | { ok: false; message: string };

type UnitSymbol = 'm' | 'h' | 'd' | 'w';

const MINUTES: Record<UnitSymbol, number> = { w: 10080, d: 1440, h: 60, m: 1 };

/** The canonical form; parseDuration accepts nothing else. Also used as the JSON Schema pattern. */
export const DURATION_PATTERN = '^[1-9][0-9]*[mhdw]$';

const CANONICAL = new RegExp(DURATION_PATTERN, 'u');

/** Durations convert to seconds for Bun, so the number of seconds must stay a safe integer. */
const MAX_MINUTES = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 60));

const HINT = 'use a whole number followed by m (minutes), h (hours), d (days) or w (weeks), e.g. "36h", "3d" or "1w"';
const ZERO = 'must be longer than zero; to leave release-age settings unmanaged, remove the cooldown section';

const UNIT_WORDS: Readonly<Record<string, UnitSymbol | 'months' | 'seconds'>> = {
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  wk: 'w',
  wks: 'w',
  week: 'w',
  weeks: 'w',
  mo: 'months',
  mos: 'months',
  month: 'months',
  months: 'months',
  y: 'months',
  yr: 'months',
  yrs: 'months',
  year: 'months',
  years: 'months',
  s: 'seconds',
  sec: 'seconds',
  secs: 'seconds',
  second: 'seconds',
  seconds: 'seconds',
  ms: 'seconds',
  millisecond: 'seconds',
  milliseconds: 'seconds',
};

interface Token {
  number: string;
  unit: string;
}

/** Splits loosely written input such as "3 Days" or "1d12h" so that errors can suggest the canonical form. */
function tokenize(input: string): Token[] | undefined {
  const token = /\s*(\d+(?:\.\d*)?|\.\d+)\s*([A-Za-z]*)\s*/y;
  const tokens: Token[] = [];
  while (token.lastIndex < input.length) {
    const match = token.exec(input);
    if (match === null) return undefined;
    tokens.push({ number: match[1] ?? '', unit: match[2] ?? '' });
  }
  return tokens.length > 0 ? tokens : undefined;
}

function unitOf(unit: string): UnitSymbol | 'months' | 'seconds' | undefined {
  // Capital M means months in Renovate and in the ms library, so never read it as minutes.
  if (unit === 'M') return 'months';
  return UNIT_WORDS[unit.toLowerCase()];
}

/** Writes minutes with the largest unit that represents them exactly, e.g. 2160 → "36h". */
export function formatDuration(minutes: number): string {
  for (const symbol of ['w', 'd', 'h'] as const) {
    if (minutes % MINUTES[symbol] === 0) return `${minutes / MINUTES[symbol]}${symbol}`;
  }
  return `${minutes}m`;
}

function failure(message: string): DurationResult {
  return { ok: false, message };
}

export function parseDuration(input: string): DurationResult {
  if (input.trim() === '') return failure(HINT);
  if (input.trim().startsWith('-')) return failure(ZERO);

  const tokens = tokenize(input);
  if (tokens === undefined) return failure(HINT);

  const units = tokens.map((token) => (token.unit === '' ? undefined : unitOf(token.unit)));
  if (units.includes('months')) {
    return failure('months and years are not supported because their length varies; use days or weeks, e.g. "30d"');
  }
  if (units.includes('seconds')) return failure('seconds are not supported; the smallest unit is m (minutes)');
  const unknown = tokens.find((token, index) => token.unit !== '' && units[index] === undefined);
  if (unknown !== undefined) return failure(`unknown unit "${unknown.unit}"; ${HINT}`);

  // Sum exactly: scale every number to the same count of decimal places.
  const decimals = Math.max(...tokens.map((token) => token.number.split('.')[1]?.length ?? 0));
  const scale = 10n ** BigInt(decimals);
  let scaled = 0n;
  for (const [index, token] of tokens.entries()) {
    const [whole = '', fraction = ''] = token.number.split('.');
    const symbol = units[index] as UnitSymbol | undefined;
    scaled += BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`) * BigInt(symbol === undefined ? 0 : MINUTES[symbol]);
  }
  if (tokens.every((token) => /^[0.]*$/u.test(token.number))) return failure(ZERO);
  if (units.includes(undefined)) return failure(`a unit is missing; ${HINT}`);

  const minutes = (scaled + scale - 1n) / scale;
  if (minutes > MAX_MINUTES) return failure('too large');
  if (tokens.some((token) => token.number.includes('.'))) {
    const exact = scaled % scale === 0n;
    return failure(`fractions are not supported; ${exact ? `write "${formatDuration(Number(minutes))}"` : HINT}`);
  }

  if (CANONICAL.test(input)) return { ok: true, duration: { text: input, minutes: Number(minutes) } };

  const [first] = tokens;
  const suggestion =
    tokens.length === 1 && first !== undefined ? `${BigInt(first.number)}${units[0] as UnitSymbol}` : formatDuration(Number(minutes));
  const reason = /\s/u.test(input)
    ? 'spaces are not allowed'
    : tokens.some((token) => token.unit !== token.unit.toLowerCase())
      ? 'units are lowercase'
      : tokens.some((token) => token.unit.length > 1)
        ? 'use the short unit'
        : tokens.length > 1
          ? 'use a single unit'
          : 'leading zeros are not allowed';
  return failure(`${reason}; write "${suggestion}"`);
}
