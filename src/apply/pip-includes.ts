// pip reads the options of every requirements and constraints file that a requirements file includes (-r, -c), at the
// line that includes it, into the one FormatControl of the install, and the options after a requirement on its line
// too (extra.formatControl). So --no-binary <name>, --no-binary=:all: or --only-binary=:none: in an included file undoes
// the --only-binary=:all: of the managed block in requirements.txt (decision D-167). apply comments such option lines out
// in the included files inside the repository, with the marker it uses in requirements.txt, and brings them back once
// the policy no longer forbids building; a line it cannot comment out, or a file it cannot read, is a warning. doctor
// follows the same lines when it decides whether building from source is forbidden.
import { includedFile, requirementsIncludes, requirementsLines } from '../doctor/python-lockfiles.ts';
import { expandRequirementsOption } from '../doctor/python.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { joinLines, splitLines, SUPERSEDED } from './block.ts';
import { extraOf, isRecord } from './facts.ts';

/** The option names and special values of pip's FormatControl (extra.formatControl). */
export interface FormatControlFacts {
  noBinary: string;
  onlyBinary: string;
  all: string;
  none: string;
  separator: string;
}

const isFacts = (value: unknown): value is FormatControlFacts =>
  isRecord(value) && ['noBinary', 'onlyBinary', 'all', 'none', 'separator'].every((key) => typeof value[key] === 'string');

/** pip's FormatControl facts; undefined for a tool without them. */
export function formatControlFacts(tool: ToolKnowledge): FormatControlFacts | undefined {
  return tool.extra?.['formatControl'] === undefined ? undefined : extraOf(tool, 'formatControl', isFacts);
}

/** One --no-binary or --only-binary option, with the option as pip reads it (an abbreviation expanded). */
export interface BinaryOption {
  option: string;
  value: string;
}

/** Words as Python's shlex.split reads them (POSIX mode, no comments): quotes and backslashes group characters. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: '' | '"' | "'" = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) word += text[++index] ?? '';
      else word += char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= '';
    if (char === "'" || char === '"') quote = char;
    else if (char === '\\') word += text[++index] ?? '';
    else word += char;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** What a logical line of a requirements file sets of FormatControl, as pip parses it. */
export interface LineOptions {
  options: BinaryOption[];
  /** The line names a requirement before its options. */
  requirement: boolean;
  /** The line has options besides --no-binary and --only-binary. */
  others: boolean;
}

/**
 * The --no-binary and --only-binary options of a logical line as pip parses it: break_args_options leaves the words up
 * to the first that starts with - to the requirement and gives the rest to optparse, which takes an unambiguous prefix
 * of a long option (`longOptions`) and its value after = or as the next word.
 */
export function binaryOptions(line: string, facts: FormatControlFacts, longOptions: readonly string[]): LineOptions {
  const tokens = line.split(' ');
  const first = tokens.findIndex((token) => token.startsWith('-'));
  const requirement = (first === -1 ? tokens : tokens.slice(0, first)).join(' ').trim() !== '';
  const words = first === -1 ? [] : shellWords(tokens.slice(first).join(' '));
  const options: BinaryOption[] = [];
  let others = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? '';
    if (!word.startsWith('-')) continue;
    const equals = word.indexOf('=');
    const name = word.startsWith('--') ? expandRequirementsOption(equals === -1 ? word : word.slice(0, equals), longOptions) : word;
    if (name !== facts.noBinary && name !== facts.onlyBinary) {
      others = true;
      continue;
    }
    const value = equals === -1 ? (words[++index] ?? '') : word.slice(equals + 1);
    options.push({ option: name, value });
  }
  return { options, requirement, others };
}

/**
 * Whether an option, read after --only-binary=:all: and the --no-binary of the packages `allowed` (normalized names),
 * lets pip build another package from source (handle_mutual_excludes): --no-binary with :all: or with a name not
 * allowed, --only-binary with :none: after its last :all:.
 */
export function weakens(option: BinaryOption, allowed: ReadonlySet<string>, facts: FormatControlFacts): boolean {
  const parts = option.value.split(facts.separator);
  if (option.option === facts.noBinary) {
    return parts.includes(facts.all) || parts.some((part) => part !== facts.none && part !== '' && !allowed.has(normalizePythonName(part)));
  }
  return parts.slice(parts.lastIndexOf(facts.all) + 1).includes(facts.none);
}

/** The options as messages show them: `--no-binary psycopg2` and `--only-binary :none:`. */
export function optionsText(options: readonly BinaryOption[]): string {
  const texts = options.map((option) => `${option.option} ${option.value}`);
  return texts.length <= 1 ? (texts[0] ?? '') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1) ?? ''}`;
}

/** What the options make pip do, for messages: build every package from source, or some named ones. */
export function weakeningEffect(options: readonly BinaryOption[], facts: FormatControlFacts): string {
  const parts = (option: BinaryOption) => option.value.split(facts.separator);
  if (options.some((option) => option.option === facts.noBinary && parts(option).includes(facts.all))) return 'makes pip build every package from source';
  if (options.some((option) => option.option === facts.onlyBinary)) return 'lets pip build any package from source again';
  const names = [...new Set(options.flatMap((option) => parts(option).filter((part) => part !== facts.none && part !== '')))];
  return `makes pip build ${names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`} from source`;
}

/** A line with options that undo the block, which apply does not comment out, and why. */
export interface KeptLine {
  line: number;
  options: BinaryOption[];
  reason: 'requirement' | 'options' | 'continued';
}

interface Reading {
  facts: FormatControlFacts;
  format: Record<string, unknown>;
  longOptions: readonly string[];
}

/** The lines of a requirements file whose options undo the block (decision D-167); `allowed` holds normalized names. */
function weakeningLines(text: string, reading: Reading, allowed: ReadonlySet<string>): { line: number; end: number; parsed: LineOptions; options: BinaryOption[] }[] {
  return requirementsLines(text, reading.format).flatMap(({ text: body, line, end }) => {
    const parsed = binaryOptions(body, reading.facts, reading.longOptions);
    const options = parsed.options.filter((option) => weakens(option, allowed, reading.facts));
    return options.length === 0 ? [] : [{ line, end, parsed, options }];
  });
}

/** Why apply leaves a weakening line as it is, or undefined when it comments the line out. */
function keptReason(parsed: LineOptions, line: number, end: number): KeptLine['reason'] | undefined {
  if (parsed.requirement) return 'requirement';
  if (parsed.others) return 'options';
  return end > line ? 'continued' : undefined;
}

/** The lines of a requirements file (requirements.txt itself) whose options undo the block and stay. */
export function keptLines(text: string, reading: Reading, allowed: ReadonlySet<string>): KeptLine[] {
  return weakeningLines(text, reading, allowed).map(({ line, end, parsed, options }) => ({ line, options, reason: keptReason(parsed, line, end) ?? 'options' }));
}

/**
 * An included file after apply: the option lines that undo the block commented out with the marker of requirements.txt
 * (`allowed` given: the block is written), and lines commented out so before brought back when they no longer undo it
 * (`allowed` undefined: no block). Lines it cannot comment out are returned.
 */
export function editIncluded(body: string, reading: Reading, allowed: ReadonlySet<string> | undefined): { text: string; kept: KeptLine[] } {
  const lines = splitLines(body);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(SUPERSEDED)) continue;
    const original = trimmed.slice(SUPERSEDED.length);
    if (allowed === undefined || weakeningLines(original, reading, allowed).length === 0) lines[index] = original;
  }
  if (allowed === undefined) return { text: joinLines(lines), kept: [] };
  const kept: KeptLine[] = [];
  for (const { line, end, parsed, options } of weakeningLines(joinLines(lines), reading, allowed)) {
    const reason = keptReason(parsed, line, end);
    if (reason === undefined) lines[line - 1] = `${SUPERSEDED}${(lines[line - 1] ?? '').trim()}`;
    else kept.push({ line, options, reason });
  }
  return { text: joinLines(lines), kept };
}

/**
 * How many files of one tree of includes depcurfew follows, and how many steps the reading of --only-binary may take
 * (a file included twice by each file above it would be read 2^depth times); past them it says so instead of running
 * for ever (decision D-191).
 */
export const MAX_REQUIREMENTS_FILES = 1000;
export const MAX_FORMAT_STEPS = 200_000;

/** The reading of --only-binary went past MAX_REQUIREMENTS_FILES or MAX_FORMAT_STEPS. */
class TooManyIncludes extends Error {}

/** What reading a file does to one set of FormatControl: whether it empties the set, and the names it puts in (true) or takes out (false) after that. */
interface SetChange {
  cleared: boolean;
  names: Map<string, boolean>;
}

/** What reading a file, with the files it includes, does to FormatControl, and the file of its last --only-binary=:all:. */
interface FormatChange {
  only: SetChange;
  no: SetChange;
  from: string | undefined;
}

function clearSet(set: SetChange): void {
  set.cleared = true;
  set.names.clear();
}

/** `change` followed by `next`: what next empties is empty, and the names next puts in or takes out are so. */
function follow(change: FormatChange, next: FormatChange): void {
  for (const key of ['only', 'no'] as const) {
    if (next[key].cleared) clearSet(change[key]);
    for (const [name, present] of next[key].names) change[key].names.set(name, present);
  }
  change.from = next.from ?? change.from;
}

/**
 * The final FormatControl of an install from `root` (decision D-167): whether --only-binary=:all: holds, and from which
 * file. `identity` names a file by its real path, so that a file reached through a symlink back up counts as the one
 * already on the way (decision D-191). What each file does is worked out once and reused wherever it is included again,
 * unless it depends on the files above it (it includes one of them); past MAX_REQUIREMENTS_FILES files or
 * MAX_FORMAT_STEPS steps the result is `stopped`, and the switch counts as not holding: depcurfew cannot tell.
 */
export function formatControlAfter(
  read: (file: string) => string | undefined,
  root: string,
  reading: Reading,
  identity: (file: string) => string = (file) => file,
): { onlyAll: boolean; from: string | undefined; stopped: boolean } {
  const { facts } = reading;
  // handle_mutual_excludes of pip's FormatControl, on what reading a file does.
  const apply = (change: FormatChange, key: 'only' | 'no', value: string, file: string) => {
    const target = change[key];
    const other = change[key === 'only' ? 'no' : 'only'];
    let parts = value.split(facts.separator);
    while (parts.includes(facts.all)) {
      clearSet(other);
      clearSet(target);
      target.names.set(facts.all, true);
      if (key === 'only') change.from = file;
      parts = parts.slice(parts.indexOf(facts.all) + 1);
      if (!parts.includes(facts.none)) return;
    }
    for (const part of parts) {
      if (part === facts.none) {
        clearSet(target);
        continue;
      }
      const name = normalizePythonName(part);
      other.names.set(name, false);
      target.names.set(name, true);
    }
  };
  let steps = 0;
  const step = (count: number) => {
    steps += count;
    if (steps > MAX_FORMAT_STEPS) throw new TooManyIncludes();
  };
  // Each file is read once, however often it is included: its includes, resolved and named by their real path, and
  // its --no-binary and --only-binary options, in the order pip reads them (decision D-191).
  type Item = { kind: 'include'; target: string; real: string } | { kind: 'options'; options: BinaryOption[] };
  const prepared = new Map<string, { file: string; items: Item[] } | undefined>();
  const prepare = (file: string, real: string) => {
    if (!prepared.has(real)) {
      if (prepared.size >= MAX_REQUIREMENTS_FILES) throw new TooManyIncludes();
      const text = read(file);
      if (text === undefined) prepared.set(real, undefined);
      else {
        const includes = new Map(requirementsIncludes(text, reading.format).map((include) => [include.line, include.path]));
        const items: Item[] = [];
        for (const { text: body, line } of requirementsLines(text, reading.format)) {
          const path = includes.get(line);
          if (path === undefined) {
            const { options } = binaryOptions(body, facts, reading.longOptions);
            if (options.length > 0) items.push({ kind: 'options', options });
            continue;
          }
          const included = includedFile(file, path);
          if (!included.url && !included.outside) items.push({ kind: 'include', target: included.target, real: identity(included.target) });
        }
        prepared.set(real, { file, items });
      }
    }
    return prepared.get(real);
  };
  // What a file does, by its real path, when it does not depend on the files above it: when what it includes, and what
  // that includes, never includes a file on the way to it. Then it does the same wherever it is included (decision D-191).
  const known = new Map<string, FormatChange>();
  // The files on the way to the one read, by real path.
  const onWay = new Set<string>();
  const visit = (file: string, real: string): { change: FormatChange; pure: boolean } => {
    const reused = known.get(real);
    if (reused !== undefined) return { change: reused, pure: true };
    step(1);
    const change: FormatChange = { only: { cleared: false, names: new Map() }, no: { cleared: false, names: new Map() }, from: undefined };
    const content = prepare(file, real);
    if (content === undefined) return { change, pure: true };
    let pure = true;
    onWay.add(real);
    for (const item of content.items) {
      if (item.kind === 'options') {
        for (const option of item.options) apply(change, option.option === facts.noBinary ? 'no' : 'only', option.value, content.file);
        continue;
      }
      // pip stops at a file that includes itself; depcurfew stops following it, also through a symlink. A file that
      // includes itself does so wherever it is read; one that includes a file above it, only on this way.
      if (onWay.has(item.real)) {
        if (item.real !== real) pure = false;
        continue;
      }
      const inner = visit(item.target, item.real);
      pure &&= inner.pure;
      step(1 + inner.change.only.names.size + inner.change.no.names.size);
      follow(change, inner.change);
    }
    onWay.delete(real);
    if (pure) known.set(real, change);
    return { change, pure };
  };
  try {
    const { change } = visit(root, identity(root));
    const onlyAll = change.only.names.get(facts.all) === true;
    return { onlyAll, from: onlyAll ? change.from : undefined, stopped: false };
  } catch (error) {
    if (error instanceof TooManyIncludes) return { onlyAll: false, from: undefined, stopped: true };
    throw error;
  }
}
