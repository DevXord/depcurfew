// A Gemfile read as Ruby's lexer reads it (decision D-159), without running Ruby. Bundler runs the Gemfile with
// instance_eval (extra.gemfileEvaluation), so Ruby's parser decides which lines are code: comments, =begin ... =end,
// the end of the script (__END__, and NUL, ^D or ^Z where a token starts), string and %-literals with any delimiter
// (paired ones nest), and heredocs, whose bodies Ruby reads from the line after the one that starts them. The scanner
// follows parse.y (extra.rubySyntax) as far as it needs to know where each literal ends, which lines start a statement
// and which code is nested in a block, method, class, condition, loop or begin (decision D-163), in one pass over the
// text, with \r\n read as one newline as Ruby reads it. Where Ruby's reading depends on something a lexer cannot see
// (whether a name is a local variable), where Prism, the default parser since Ruby 3.4, reads the text otherwise than
// parse.y (extra.rubyParsers), or on a construct the scanner does not follow, it stops and says where: the file is
// then not understood, and depcurfew neither edits it nor counts a cooldown in it.
import { bundler } from '../knowledge/bundler.ts';
import { extraOf, isRecord } from './facts.ts';

interface RubySyntax {
  endOfScript: { marker: string; characters: string[] };
  embeddedDocument: [string, string];
  percentLiterals: { expanding: string[]; plain: string[] };
  pairedDelimiters: Record<string, string>;
  heredocIndent: string[];
  globalPunctuation: string;
  numberSuffixes: string[];
  lineEnding: string;
  keywords: Record<
    'end' | 'statement' | 'value' | 'mid' | 'argument' | 'methodName' | 'className' | 'names' | 'modifiers' | 'opening' | 'loops' | 'closing',
    string[]
  >;
}

interface RubyParsers {
  differences: { characterBeyondAscii: boolean; embeddedDocumentAfter: string[]; globalZeroWithName: boolean };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isSyntax = (value: unknown): value is RubySyntax =>
  isRecord(value) &&
  isRecord(value['endOfScript']) &&
  typeof value['endOfScript']['marker'] === 'string' &&
  isStrings(value['endOfScript']['characters']) &&
  isStrings(value['embeddedDocument']) &&
  value['embeddedDocument'].length === 2 &&
  isRecord(value['percentLiterals']) &&
  isStrings(value['percentLiterals']['expanding']) &&
  isStrings(value['percentLiterals']['plain']) &&
  isRecord(value['pairedDelimiters']) &&
  isStrings(value['heredocIndent']) &&
  typeof value['globalPunctuation'] === 'string' &&
  isStrings(value['numberSuffixes']) &&
  typeof value['lineEnding'] === 'string' &&
  isRecord(value['keywords']) &&
  Object.values(value['keywords']).every(isStrings) &&
  ['opening', 'loops', 'closing'].every((key) => isRecord(value['keywords']) && isStrings(value['keywords'][key])) &&
  (value['keywords']['closing'] as string[]).length === 1;

const isParsers = (value: unknown): value is RubyParsers =>
  isRecord(value) &&
  isRecord(value['differences']) &&
  typeof value['differences']['characterBeyondAscii'] === 'boolean' &&
  isStrings(value['differences']['embeddedDocumentAfter']) &&
  typeof value['differences']['globalZeroWithName'] === 'boolean';

const SYNTAX = extraOf(bundler, 'rubySyntax', isSyntax);
const DIFFERENCES = extraOf(bundler, 'rubyParsers', isParsers).differences;
const [EMBEDDED_BEGIN, EMBEDDED_END] = SYNTAX.embeddedDocument;
const END_CHARACTERS = new Set(SYNTAX.endOfScript.characters);
const PAIRS = new Map(Object.entries(SYNTAX.pairedDelimiters).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
const EXPANDING = new Set(SYNTAX.percentLiterals.expanding);
const PERCENT_TYPES = new Set([...SYNTAX.percentLiterals.expanding, ...SYNTAX.percentLiterals.plain]);
const HEREDOC_INDENT = new Set(SYNTAX.heredocIndent);
const GLOBAL_PUNCTUATION = new Set(SYNTAX.globalPunctuation);
/** The characters after =begin that start a comment for parse.y only (extra.rubyParsers). */
const EMBEDDED_PARSE_Y_ONLY = new Set(DIFFERENCES.embeddedDocumentAfter);
/** Keywords whose code end closes, the loops whose condition may end with do, and end. */
const OPENING = new Set(SYNTAX.keywords.opening);
const LOOPS = new Set(SYNTAX.keywords.loops);
const CLOSING = new Set(SYNTAX.keywords.closing);
const END_KEYWORD = SYNTAX.keywords.closing.join(' ');
/** The brackets that nest code: ( [ { and what closes them (pairedDelimiters without <). */
const BRACKETS = new Map([...PAIRS].filter(([open]) => open !== '<'));

/**
 * The lexer state as far as it matters here (parse.y EXPR_*): stmt, a statement begins (after a line that ended one,
 * ;, do, then, else, begin, ensure); beg, an expression begins (after an operator or a keyword like if); begLabel, the
 * same where a label may come (after , ( [ { | or a label); mid, after return, break, next, rescue; end, after a value;
 * arg, after the name of a method that takes arguments without parentheses; ident, after a lower-case name that is a
 * local variable or a method call (end or arg, Ruby knows which, the scanner does not); dot, after . &. or ::; fname,
 * the name of a method after def; class, after class.
 */
type State = 'stmt' | 'beg' | 'begLabel' | 'mid' | 'end' | 'arg' | 'ident' | 'dot' | 'fname' | 'class';

const KEYWORD_STATES = new Map<string, State | 'def' | 'names'>([
  ...SYNTAX.keywords.end.map((word) => [word, 'end'] as const),
  ...SYNTAX.keywords.statement.map((word) => [word, 'stmt'] as const),
  ...SYNTAX.keywords.value.map((word) => [word, 'beg'] as const),
  ...SYNTAX.keywords.mid.map((word) => [word, 'mid'] as const),
  ...SYNTAX.keywords.argument.map((word) => [word, 'arg'] as const),
  ...SYNTAX.keywords.methodName.map((word) => [word, 'def'] as const),
  ...SYNTAX.keywords.className.map((word) => [word, 'class'] as const),
  ...SYNTAX.keywords.names.map((word) => [word, 'names'] as const),
]);
const MODIFIERS = new Set(SYNTAX.keywords.modifiers);

/** Where an expression begins: %, / and << start literals there, ? a character literal. */
const BEGINS = new Set<State>(['stmt', 'beg', 'begLabel', 'mid', 'class']);
/** Where if, unless, while, until and rescue are no modifiers (EXPR_BEG, after a label, after class; not after return). */
const KEYWORD_BEGINS = new Set<State>(['stmt', 'beg', 'begLabel', 'class']);
/** States in which Ruby ignores a newline (EXPR_BEG, EXPR_CLASS, EXPR_FNAME, EXPR_DOT, and a label). */
const IGNORES_NEWLINE = new Set<State>(['stmt', 'beg', 'begLabel', 'class', 'fname', 'dot']);
/** States after which a name followed by : is a label (IS_LABEL_POSSIBLE). */
const LABEL_POSSIBLE = new Set<State>(['begLabel', 'arg', 'ident']);
/** The operators of code, longest first. */
const OPERATORS = ['**=', '<=>', '===', '...', '&&=', '||=', '<<=', '>>=', '**', '==', '=~', '=>', '!=', '!~', '>=', '<=', '>>', '&&', '||', '&.', '..', '::', '->', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '=', '!', '>', '&', '|', '+', '-', '*', '%', '^', '~', '(', ')', '[', ']', ',', ';', '.'];
/** The operators by their first character, longest first, so that each token tries a few. */
const OPERATORS_BY_FIRST = new Map<string, string[]>();
for (const operator of OPERATORS) OPERATORS_BY_FIRST.set(operator[0] ?? '', [...(OPERATORS_BY_FIRST.get(operator[0] ?? '') ?? []), operator]);
/** The operators a symbol can name (:<=>, :[]=), longest first. */
const SYMBOL_OPERATORS = ['<=>', '===', '[]=', '==', '=~', '!=', '!~', '[]', '**', '>=', '>>', '<=', '<<', '+@', '-@', '!', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '~', '`'];

/** A token of a line that starts with the name source, for reading the call. */
export interface ScanToken {
  kind: 'ident' | 'const' | 'keyword' | 'label' | 'symbol' | 'string' | 'number' | 'op' | 'comment' | 'other';
  /** As written; a label without its colon (and for "key": without the quotes). */
  text: string;
  start: number;
  end: number;
  /** Whitespace came right before it. */
  space: boolean;
  /** A string in ' or " on one line without escapes Ruby changes or interpolation: its value. */
  value?: string;
}

/** A line of the top-level code whose first token is the name source. */
export interface ScannedLine {
  /** 1-based. */
  line: number;
  start: number;
  /** It starts a statement: the line before ended one (or ;, do, then, else, begin, ensure). */
  statement: boolean;
  /** It starts outside any block, method, class, condition, loop, begin or bracket: Ruby runs it with the file. */
  topLevel: boolean;
  tokens: ScanToken[];
  /** The line ended in the top-level code with nothing left open: no string, heredoc or interpolation. */
  complete: boolean;
  /** A do or a block { is on the line. */
  block: boolean;
}

/** Where the scanner stopped reading with certainty: the line, why, and what would let depcurfew read on. */
export interface ScanUnknown {
  line: number;
  reason: string;
  fix: string;
}

export interface RubyScan {
  /** The text as Ruby reads it, \r\n as \n: the positions of the tokens are in it. */
  text: string;
  lines: ScannedLine[];
  unknown?: ScanUnknown;
}

/** Code that a keyword or a bracket opened and is not closed yet. */
interface Opened {
  /** What opened it (do, if, def, {, ( …), for messages. */
  open: string;
  /** What closes it: end, }, ) or ]. */
  close: string;
  /** 0-based line where it opened. */
  line: number;
  /** while, until, for: the do that ends the condition may still come (keyword_do_cond). */
  condition?: boolean;
  /**
   * def until its body starts: before its name, after it, in the parentheses of its parameters, after them. = after the
   * name or the parameters makes it an endless method, which end does not close.
   */
  header?: 'name' | 'named' | 'parameters' | 'afterParameters';
}

interface CodeFrame {
  kind: 'code';
  state: State;
  /** The code open inside this frame, innermost last; an interpolation ends at a } with nothing open. */
  opened: Opened[];
  /** ? of a ternary without its : yet, in this statement. */
  ternary: number;
  /** Block parameters: 1 right after do or a block {, 2 inside | ... |. */
  params: 0 | 1 | 2;
  space: boolean;
  interpolation: boolean;
  line: number;
}

interface StringFrame {
  kind: 'string';
  term: string;
  paren: string;
  nest: number;
  expand: boolean;
  regexp: boolean;
  /** Started where a label may come: "key": is a label. */
  label: boolean;
  /** ' or " for a plain string literal, '' for any other (%q, :"…", `…`, /…/). */
  quote: string;
  symbol: boolean;
  start: number;
  line: number;
  /** An escape or an interpolation Ruby changes the text with. */
  changed: boolean;
}

interface HeredocFrame {
  kind: 'heredoc';
  id: string;
  indent: boolean;
  expand: boolean;
  /** The line before ended with a backslash: this line is no terminator. */
  continued: boolean;
  line: number;
}

type Frame = CodeFrame | StringFrame | HeredocFrame;

interface PendingHeredoc {
  id: string;
  indent: boolean;
  expand: boolean;
  line: number;
}

const MAX_TOKENS = 1000;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}

function isAlnum(c: string | undefined): boolean {
  return isDigit(c) || isAlpha(c);
}

function isNonAscii(c: string | undefined): boolean {
  return c !== undefined && c.charCodeAt(0) >= 0x80;
}

/** parser_is_identchar: a letter, a digit, _ or a character beyond ASCII. */
function isIdentChar(c: string | undefined): boolean {
  return isAlnum(c) || c === '_' || isNonAscii(c);
}

function isIdentStart(c: string | undefined): boolean {
  return isAlpha(c) || c === '_' || isNonAscii(c);
}

/** ISSPACE in parse.y. */
function isRubySpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
}

/** Whitespace between tokens on a line (the newline is not). */
function isInlineSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\r';
}

class Stop extends Error {}

class Scanner {
  readonly #text: string;
  #i = 0;
  /** 0-based line of #i. */
  #line = 0;
  #lineStart = 0;
  #atLineStart = true;
  readonly #stack: Frame[] = [];
  #pending: PendingHeredoc[] = [];
  readonly #lines: ScannedLine[] = [];
  #recording: (ScannedLine & { full: boolean }) | undefined;
  #unknown: ScanUnknown | undefined;
  #done = false;

  constructor(text: string) {
    this.#text = text;
    if (text.charCodeAt(0) === 0xfeff) this.#i = 1;
    this.#stack.push(this.#code(false));
  }

  #code(interpolation: boolean): CodeFrame {
    return { kind: 'code', state: 'stmt', opened: [], ternary: 0, params: 0, space: false, interpolation, line: this.#line };
  }

  /** Opens code that `close` closes. */
  #open(frame: CodeFrame, open: string, close: string, extra?: Pick<Opened, 'condition' | 'header'>): void {
    const opened: Opened = { open, close, line: this.#line };
    if (extra?.condition !== undefined) opened.condition = extra.condition;
    if (extra?.header !== undefined) opened.header = extra.header;
    frame.opened.push(opened);
  }

  /** Closes the innermost open code with `close` (end, }, ), ]); Ruby reports a syntax error for any other. */
  #close(frame: CodeFrame, close: string): void {
    const innermost = frame.opened.at(-1);
    if (innermost === undefined) this.#syntaxError(close === 'end' ? 'an end without anything to close' : `a ${close} without ${[...BRACKETS].find(([, end]) => end === close)?.[0] ?? 'its opening'}`);
    if (innermost.close !== close) this.#syntaxError(`a ${close} where the ${innermost.open} that starts on line ${innermost.line + 1} needs ${innermost.close}`);
    frame.opened.pop();
    const outer = frame.opened.at(-1);
    if (close === ')' && outer?.header === 'parameters') outer.header = 'afterParameters';
  }

  /** The name of the method a def defines has been read. */
  #named(frame: CodeFrame): void {
    const innermost = frame.opened.at(-1);
    if (innermost?.header === 'name') innermost.header = 'named';
  }

  /**
   * The token after the name of a def, or after its parameters in parentheses: = makes it an endless method (def
   * name = value, def name(a) = value), which end does not close; ( starts its parameters; any other starts its body.
   */
  #methodHeader(frame: CodeFrame, c: string, next: string | undefined): void {
    const innermost = frame.opened.at(-1);
    if (innermost === undefined || (innermost.header !== 'named' && innermost.header !== 'afterParameters')) return;
    if (c === '=' && next !== '=' && next !== '~' && next !== '>') frame.opened.pop();
    else if (c === '(' && innermost.header === 'named') innermost.header = 'parameters';
    else delete innermost.header;
  }

  /**
   * The end of the number that starts at `at`, as parse_numeric reads it: a prefix and its digits, a fraction and an
   * exponent only before a digit, the suffixes r and i only when no name character follows, so 1end and 1do end
   * before the keyword. A name right after a number that is no keyword is a syntax error in Ruby.
   */
  #numberEnd(at: number): number {
    const text = this.#text;
    const run = (from: number, digit: (c: string | undefined) => boolean): number => {
      let j = from;
      while (digit(text[j]) || text[j] === '_') j++;
      return j;
    };
    const prefix = text[at] === '0' ? text[at + 1]?.toLowerCase() : undefined;
    let j: number;
    if (prefix === 'x') j = run(at + 2, (c) => c !== undefined && /^[0-9a-fA-F]$/u.test(c));
    else if (prefix === 'b' || prefix === 'o' || prefix === 'd') j = run(at + 2, isDigit);
    else {
      j = run(at, isDigit);
      if (text[j] === '.' && isDigit(text[j + 1])) j = run(j + 1, isDigit);
      if ((text[j] === 'e' || text[j] === 'E') && (isDigit(text[j + 1]) || ((text[j + 1] === '+' || text[j + 1] === '-') && isDigit(text[j + 2])))) {
        j = run(text[j + 1] === '+' || text[j + 1] === '-' ? j + 2 : j + 1, isDigit);
      }
    }
    let k = j;
    for (const suffix of SYNTAX.numberSuffixes) if (text[k] === suffix) k++;
    if (!isIdentChar(text[k])) return k;
    let end = j;
    while (isIdentChar(text[end])) end++;
    const word = text.slice(j, end);
    if (!KEYWORD_STATES.has(word)) this.#syntaxError(`the number ${text.slice(at, j)} followed by the name ${word}`);
    return j;
  }

  /** The statement ends: a while, until or for condition can no longer end with do. */
  #endStatement(frame: CodeFrame): void {
    frame.ternary = 0;
    const innermost = frame.opened.at(-1);
    if (innermost?.condition === true) innermost.condition = false;
  }

  run(): RubyScan {
    try {
      while (!this.#done) {
        if (this.#i >= this.#text.length) {
          this.#finish();
          break;
        }
        if (this.#atLineStart) {
          this.#atLineStart = false;
          if (this.#startLine()) continue;
        }
        const frame = this.#top();
        if (frame.kind === 'code') this.#codeStep(frame);
        else if (frame.kind === 'string') this.#stringStep(frame);
        else this.#heredocStep(frame);
      }
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
    }
    this.#closeLine(false);
    return { text: this.#text, lines: this.#lines, ...(this.#unknown === undefined ? {} : { unknown: this.#unknown }) };
  }

  #top(): Frame {
    const frame = this.#stack.at(-1);
    if (frame === undefined) throw new Stop();
    return frame;
  }

  /** Stops the scan: what follows cannot be read with certainty. */
  #fail(reason: string, fix: string, line = this.#line): never {
    this.#unknown = { line: line + 1, reason, fix };
    this.#done = true;
    throw new Stop();
  }

  #syntaxError(what: string, line = this.#line): never {
    this.#fail(`Ruby reports a syntax error there (${what})`, 'fix the syntax error (ruby -c shows it)', line);
  }

  /** Ruby stops reading the script here; nothing after it is code. */
  #endOfScript(): void {
    const frame = this.#stack[0];
    const open = frame?.kind === 'code' ? frame.opened.at(-1) : undefined;
    if (open !== undefined) this.#syntaxError(`the script ends before the end of the ${open.open} that starts on line ${open.line + 1}`);
    this.#closeLine(false);
    this.#done = true;
    throw new Stop();
  }

  #finish(): void {
    const pending = this.#pending[0];
    if (pending !== undefined) this.#fail(`the heredoc <<${pending.id} has no body before the end of the file`, `end the heredoc with a line ${pending.id}`, pending.line);
    const frame = this.#top();
    if (frame.kind === 'heredoc') this.#fail(`the heredoc that starts there has no line ${frame.id} that ends it`, `end the heredoc with a line ${frame.id}`, frame.line);
    if (frame.kind === 'string') this.#fail('the string or literal that starts there does not end', 'end the string', frame.line);
    if (frame.interpolation) this.#fail('the interpolation #{ that starts there does not end', 'close the interpolation with }', frame.line);
    const open = frame.opened.at(-1);
    if (open !== undefined) this.#syntaxError(`the ${open.open} that starts there has no ${open.close}`, open.line);
    this.#closeLine(true);
    this.#done = true;
  }

  /** Moves past the newline at `at` (\n): the next line starts, after the bodies of the heredocs started on this one. */
  #newline(at: number): void {
    this.#closeLine(true);
    this.#i = at + 1;
    this.#line += 1;
    this.#lineStart = this.#i;
    this.#atLineStart = true;
    if (this.#pending.length > 0) {
      for (let index = this.#pending.length - 1; index >= 0; index--) {
        const heredoc = this.#pending[index];
        if (heredoc !== undefined) this.#stack.push({ kind: 'heredoc', id: heredoc.id, indent: heredoc.indent, expand: heredoc.expand, continued: false, line: heredoc.line });
      }
      this.#pending = [];
    }
  }

  /** The end of the current line (the index of its \n, or the end of the text). */
  #lineEnd(from = this.#i): number {
    const end = this.#text.indexOf('\n', from);
    return end === -1 ? this.#text.length : end;
  }

  /** The text of the line that starts at `from`, without its \n. */
  #lineText(from: number): string {
    return this.#text.slice(from, this.#lineEnd(from));
  }

  /** Line start: a heredoc terminator, =begin, __END__, and the start of a source line. True when it moved on. */
  #startLine(): boolean {
    const frame = this.#top();
    if (frame.kind === 'heredoc') {
      if (!frame.continued) {
        let text = this.#lineText(this.#i);
        if (frame.indent) text = text.replace(/^[ \t\v\f\r]+/u, '');
        if (text === frame.id) {
          this.#stack.pop();
          const end = this.#lineEnd();
          if (end >= this.#text.length) this.#i = end;
          else this.#newline(end);
          return true;
        }
      }
      frame.continued = false;
      return false;
    }
    if (frame.kind !== 'code') return false;
    const text = this.#text;
    if (text.startsWith(EMBEDDED_BEGIN, this.#i) && this.#endsWord(this.#i + EMBEDDED_BEGIN.length)) {
      const after = text.charCodeAt(this.#i + EMBEDDED_BEGIN.length);
      if (EMBEDDED_PARSE_Y_ONLY.has(String.fromCharCode(after))) {
        this.#fail(
          `Ruby 3.3 and older (parse.y) read ${EMBEDDED_BEGIN} followed by ^${String.fromCharCode(after + 64)} as the start of a comment, and Ruby 3.4 and newer (Prism) do not`,
          `put a space or the end of the line right after ${EMBEDDED_BEGIN}`,
        );
      }
      const start = this.#line;
      for (;;) {
        const end = this.#lineEnd();
        if (end >= text.length) this.#fail(`the ${EMBEDDED_BEGIN} comment that starts there has no ${EMBEDDED_END}`, `end the comment with a line ${EMBEDDED_END}`, start);
        this.#i = end + 1;
        this.#line += 1;
        this.#lineStart = this.#i;
        if (text.startsWith(EMBEDDED_END, this.#i) && this.#endsWord(this.#i + EMBEDDED_END.length)) break;
      }
      const end = this.#lineEnd();
      if (end >= text.length) this.#i = end;
      else {
        this.#i = end + 1;
        this.#line += 1;
        this.#lineStart = this.#i;
      }
      this.#atLineStart = true;
      return true;
    }
    if (text.startsWith(SYNTAX.endOfScript.marker, this.#i) && this.#lineText(this.#i) === SYNTAX.endOfScript.marker) {
      if (this.#stack.length > 1) this.#syntaxError(`${SYNTAX.endOfScript.marker} inside an interpolation`);
      this.#endOfScript();
    }
    if (this.#stack.length === 1) this.#maybeRecord(frame);
    return false;
  }

  /** word_match_p: the word is followed by whitespace, the end of the text, NUL, ^D or ^Z. */
  #endsWord(at: number): boolean {
    const c = this.#text[at];
    return c === undefined || isRubySpace(c) || END_CHARACTERS.has(c);
  }

  #maybeRecord(frame: CodeFrame): void {
    const text = this.#text;
    let at = this.#i;
    while (isInlineSpace(text[at])) at++;
    if (!text.startsWith('source', at)) return;
    const after = text[at + 6];
    if (isIdentChar(after) || ((after === '?' || after === '!') && text[at + 7] !== '=')) return;
    this.#recording = { line: this.#line + 1, start: this.#lineStart, statement: frame.state === 'stmt', topLevel: frame.opened.length === 0, tokens: [], complete: false, block: false, full: false };
  }

  #closeLine(complete: boolean): void {
    const recording = this.#recording;
    if (recording === undefined) return;
    this.#recording = undefined;
    const { full: _full, ...line } = recording;
    line.complete = complete && !recording.full && this.#stack.length === 1 && this.#pending.length === 0 && this.#top().kind === 'code';
    this.#lines.push(line);
  }

  /** Records a token of the top-level code on a source line. */
  #token(token: Omit<ScanToken, 'space'>, frame: CodeFrame): void {
    const recording = this.#recording;
    if (recording === undefined || this.#stack.length !== 1 || frame !== this.#stack[0]) return;
    if (recording.tokens.length >= MAX_TOKENS) {
      recording.full = true;
      return;
    }
    recording.tokens.push({ ...token, space: frame.space });
  }

  /** Sets the state after a token, with the block parameters of do |a| and { |a| (a statement begins after them). */
  #after(frame: CodeFrame, state: State, text = ''): void {
    if (frame.params === 1) {
      if (text === '|') {
        frame.params = 2;
        frame.state = 'begLabel';
      } else if (text === '||') {
        frame.params = 0;
        frame.state = 'stmt';
      } else {
        frame.params = 0;
        frame.state = state;
      }
    } else if (frame.params === 2 && text === '|') {
      frame.params = 0;
      frame.state = 'stmt';
    } else {
      frame.state = state;
    }
    frame.space = false;
  }

  #ambiguous(name: string, what: string): never {
    this.#fail(
      `after the name ${name} and a space, Ruby reads ${what} one way when ${name} is a local variable and another way when it is a method, which depcurfew does not tell`,
      `write the arguments of ${name} in parentheses (${name}(...)), or put a space after the operator`,
    );
  }

  #lastName(): string {
    const recording = this.#recording?.tokens.at(-1);
    if (recording !== undefined && recording.kind === 'ident') return recording.text;
    // The name right before the current position, for the message.
    let at = this.#i - 1;
    while (at >= 0 && isInlineSpace(this.#text[at])) at--;
    const end = at + 1;
    while (at >= 0 && isIdentChar(this.#text[at])) at--;
    return this.#text.slice(at + 1, end) || 'the name before it';
  }

  #codeStep(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const c = text[i] ?? '';
    const next = text[i + 1];
    const state = frame.state;
    if (END_CHARACTERS.has(c)) {
      if (this.#stack.length > 1) this.#syntaxError('the script ends inside an interpolation');
      if (this.#pending.length > 0) this.#fail('the script ends before the body of a heredoc started on that line', 'move the end of the script to a line of its own');
      this.#endOfScript();
    }
    if (isInlineSpace(c)) {
      frame.space = true;
      this.#i = i + 1;
      return;
    }
    this.#methodHeader(frame, c, next);
    if (c === '\n') {
      if (!IGNORES_NEWLINE.has(state)) {
        frame.state = 'stmt';
        this.#endStatement(frame);
      }
      if (frame.params === 1) frame.params = 0;
      frame.space = true;
      this.#newline(i);
      return;
    }
    if (c === '\\') {
      // A backslash joins the next line to this statement, so a source call on this line goes on there.
      if (next === '\n') {
        if (this.#recording !== undefined) this.#recording.full = true;
        frame.space = true;
        this.#newline(i + 1);
        return;
      }
      this.#syntaxError('a backslash outside a string');
    }
    if (c === '#') {
      const end = this.#lineEnd(i);
      this.#token({ kind: 'comment', text: text.slice(i, end), start: i, end }, frame);
      this.#i = end;
      return;
    }
    if (isDigit(c)) {
      const j = this.#numberEnd(i);
      this.#token({ kind: 'number', text: text.slice(i, j), start: i, end: j }, frame);
      this.#i = j;
      this.#after(frame, 'end');
      return;
    }
    if (isIdentStart(c)) {
      this.#identifier(frame);
      return;
    }
    switch (c) {
      case '"':
      case "'":
        this.#openString(frame, { term: c, paren: '', expand: c === '"', regexp: false, label: LABEL_POSSIBLE.has(state), quote: c, symbol: false }, i + 1);
        return;
      case '`':
        if (state === 'dot' || state === 'fname') {
          this.#token({ kind: 'op', text: c, start: i, end: i + 1 }, frame);
          this.#i = i + 1;
          if (state === 'fname') this.#named(frame);
          this.#after(frame, state === 'dot' ? 'arg' : 'end');
          return;
        }
        this.#openString(frame, { term: '`', paren: '', expand: true, regexp: false, label: false, quote: '', symbol: false }, i + 1);
        return;
      case '?':
        this.#questionMark(frame);
        return;
      case '%':
        this.#percent(frame);
        return;
      case '/':
        this.#slash(frame);
        return;
      case '<':
        this.#lessThan(frame);
        return;
      case ':':
        this.#colon(frame);
        return;
      case '$':
        this.#i = this.#globalEnd(i) ?? this.#syntaxError(`$${next ?? ''} is no global variable`);
        this.#token({ kind: 'other', text: text.slice(i, this.#i), start: i, end: this.#i }, frame);
        this.#after(frame, 'end');
        return;
      case '@':
        this.#i = this.#instanceEnd(i) ?? this.#syntaxError(`@${next ?? ''} is no instance or class variable`);
        this.#token({ kind: 'other', text: text.slice(i, this.#i), start: i, end: this.#i }, frame);
        this.#after(frame, 'end');
        return;
      case '{': {
        const block = state === 'end' || state === 'arg' || state === 'ident';
        this.#open(frame, c, BRACKETS.get(c) ?? '}');
        this.#token({ kind: 'op', text: block ? '{' : '{hash', start: i, end: i + 1 }, frame);
        if (block && this.#recording !== undefined && this.#stack.length === 1) this.#recording.block = true;
        this.#i = i + 1;
        this.#after(frame, 'begLabel');
        if (block) frame.params = 1;
        return;
      }
      case '}':
        if (frame.opened.length === 0 && frame.interpolation) {
          this.#stack.pop();
          this.#i = i + 1;
          return;
        }
        this.#close(frame, c);
        this.#token({ kind: 'op', text: '}', start: i, end: i + 1 }, frame);
        this.#i = i + 1;
        this.#after(frame, 'end');
        return;
      default:
        this.#operator(frame);
    }
  }

  #operator(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    const c = text[i] ?? '';
    const op = OPERATORS_BY_FIRST.get(c)?.find((candidate) => text.startsWith(candidate, i));
    if (op === undefined) this.#syntaxError(`the character ${JSON.stringify(c)} where Ruby expects code`);
    if ((state === 'dot' || state === 'fname') && op !== '(' && op !== '::') {
      this.#fail('it calls or defines a method named by an operator, which depcurfew does not read', 'give the method a name of letters, or call the operator without a dot');
    }
    this.#token({ kind: 'op', text: op, start: i, end: i + op.length }, frame);
    this.#i = i + op.length;
    const close = BRACKETS.get(op);
    if (close !== undefined) this.#open(frame, op, close);
    else if (op === ')' || op === ']') this.#close(frame, op);
    let next: State;
    switch (op) {
      case ')':
      case ']':
      case '->':
        next = 'end';
        break;
      case '(':
      case '[':
      case ',':
      case '|':
        next = 'begLabel';
        break;
      case ';':
        next = 'stmt';
        this.#endStatement(frame);
        break;
      case '.':
      case '&.':
      case '::':
        next = 'dot';
        break;
      default:
        next = 'beg';
    }
    this.#after(frame, next, op);
  }

  /** A name: a keyword, a label, a method or a local variable, a constant. */
  #identifier(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    let j = i;
    while (isIdentChar(text[j])) j++;
    let fid = false;
    if ((text[j] === '?' || text[j] === '!') && text[j + 1] !== '=') {
      j++;
      fid = true;
    } else if (state === 'fname' && text[j] === '=' && text[j + 1] !== '~' && text[j + 1] !== '>' && (text[j + 1] !== '=' || text[j + 2] === '>')) {
      j++;
    }
    const word = text.slice(i, j);
    this.#i = j;
    if (state === 'fname') {
      // The name of def, or of def self.name.
      this.#token({ kind: 'ident', text: word, start: i, end: j }, frame);
      if (text[j] === '.') {
        this.#i = j + 1;
        frame.space = false;
        return;
      }
      this.#named(frame);
      this.#after(frame, 'end');
      return;
    }
    if (LABEL_POSSIBLE.has(state) && text[j] === ':' && text[j + 1] !== ':') {
      this.#token({ kind: 'label', text: word, start: i, end: j + 1 }, frame);
      this.#i = j + 1;
      this.#after(frame, 'begLabel');
      return;
    }
    if (state === 'dot') {
      this.#token({ kind: 'ident', text: word, start: i, end: j }, frame);
      this.#after(frame, 'arg');
      return;
    }
    const keyword = KEYWORD_STATES.get(word);
    if (keyword !== undefined && !isNonAscii(word[0])) {
      this.#token({ kind: 'keyword', text: word, start: i, end: j }, frame);
      if (keyword === 'names') this.#fail(`it uses ${word}, which depcurfew does not read`, `rewrite it without ${word} (alias_method or remove_method), or move it out of the Gemfile`);
      if (keyword === 'def') {
        this.#open(frame, word, END_KEYWORD, { header: 'name' });
        this.#after(frame, 'fname');
        return;
      }
      if (MODIFIERS.has(word) && !KEYWORD_BEGINS.has(state)) {
        this.#after(frame, 'begLabel');
        return;
      }
      if (word === 'do') {
        const innermost = frame.opened.at(-1);
        if (innermost?.condition === true) {
          // The do that ends the condition of while, until or for (keyword_do_cond) opens nothing of its own.
          innermost.condition = false;
          this.#after(frame, 'stmt');
          return;
        }
        this.#open(frame, word, END_KEYWORD);
        if (this.#recording !== undefined && this.#stack.length === 1) this.#recording.block = true;
        this.#after(frame, 'stmt');
        frame.params = 1;
        return;
      }
      if (CLOSING.has(word)) this.#close(frame, word);
      else if (OPENING.has(word)) this.#open(frame, word, END_KEYWORD, LOOPS.has(word) ? { condition: true } : undefined);
      this.#after(frame, keyword === 'stmt' ? 'stmt' : keyword);
      return;
    }
    const constant = word[0] !== undefined && word[0] >= 'A' && word[0] <= 'Z';
    this.#token({ kind: constant ? 'const' : 'ident', text: word, start: i, end: j }, frame);
    let next: State;
    if (state === 'end') next = 'end';
    else if (state === 'ident') next = 'ident';
    else if (constant || fid) next = 'arg';
    else if (/^_[1-9]$/u.test(word)) next = 'end';
    else next = 'ident';
    this.#after(frame, next);
  }

  #openString(frame: CodeFrame, literal: Omit<StringFrame, 'kind' | 'nest' | 'start' | 'line' | 'changed'>, contentStart: number): void {
    // The code frame keeps its space flag until the literal ends, when its token is recorded.
    this.#stack.push({ kind: 'string', ...literal, nest: 0, start: this.#i, line: this.#line, changed: false });
    this.#i = contentStart;
  }

  /** The end of a literal: its token, the regexp options, a "key": label. */
  #closeString(frame: StringFrame): void {
    const text = this.#text;
    this.#stack.pop();
    let end = this.#i + 1;
    if (frame.regexp) while (isAlpha(text[end])) end++;
    const code = this.#top();
    if (code.kind !== 'code') {
      this.#i = end;
      return;
    }
    const label = frame.label && text[end] === ':' && text[end + 1] !== ':';
    const sameLine = frame.line === this.#line;
    // ' only knows \\ and \' as escapes; a " string with an escape or an interpolation has a value depcurfew does not read.
    const value = frame.quote !== '' && sameLine && (frame.quote === "'" || !frame.changed) ? this.#decode(frame) : undefined;
    if (label) {
      this.#token({ kind: 'label', text: value ?? text.slice(frame.start, end), start: frame.start, end: end + 1, ...(value === undefined ? {} : { value }) }, code);
      this.#i = end + 1;
      this.#after(code, 'begLabel');
      return;
    }
    const kind = frame.quote !== '' && sameLine ? 'string' : frame.symbol && sameLine ? 'symbol' : 'other';
    this.#token({ kind, text: text.slice(frame.start, end), start: frame.start, end, ...(value === undefined ? {} : { value }) }, code);
    if (!sameLine && this.#recording !== undefined) this.#recording.full = true;
    this.#i = end;
    this.#after(code, 'end');
  }

  /** The value of a plain ' or " string on one line: ' keeps every backslash but those of \\ and \'. */
  #decode(frame: StringFrame): string | undefined {
    const body = this.#text.slice(frame.start + 1, this.#i);
    if (frame.quote === '"') return body;
    return body.replace(/\\([\\'])/gu, '$1');
  }

  #stringStep(frame: StringFrame): void {
    const text = this.#text;
    const i = this.#i;
    const c = text[i];
    if (frame.paren !== '' && c === frame.paren) {
      frame.nest += 1;
      this.#i = i + 1;
      return;
    }
    if (c === frame.term) {
      if (frame.nest === 0) {
        if (c === '\n') {
          // A literal delimited by newlines ends with the newline, which also ends the line.
          this.#stack.pop();
          const code = this.#top();
          if (code.kind === 'code') this.#after(code, 'end');
          if (this.#recording !== undefined) this.#recording.full = true;
          this.#newline(i);
          return;
        }
        this.#closeString(frame);
        return;
      }
      frame.nest -= 1;
      if (c === '\n') this.#newline(i);
      else this.#i = i + 1;
      return;
    }
    if (c === '\n') {
      this.#newline(i);
      return;
    }
    if (frame.expand && c === '#') {
      const next = text[i + 1];
      if (next === '{') {
        frame.changed = true;
        this.#stack.push(this.#code(true));
        this.#i = i + 2;
        return;
      }
      if (next === '@' || next === '$') {
        const end = next === '@' ? this.#instanceEnd(i + 1) : this.#globalEnd(i + 1, true);
        if (end !== undefined) {
          frame.changed = true;
          this.#i = end;
          return;
        }
      }
      this.#i = i + 1;
      return;
    }
    if (c === '\\') {
      frame.changed = true;
      this.#escape(frame.expand);
      return;
    }
    this.#i = i + 1;
  }

  /** A backslash and what it escapes, in a literal; an escaped newline continues the line. */
  #escape(expand: boolean): 'newline' | 'other' {
    const text = this.#text;
    const i = this.#i;
    const next = text[i + 1];
    if (next === undefined) this.#syntaxError('a backslash at the end of the file');
    if (next === '\n') {
      this.#newline(i + 1);
      return 'newline';
    }
    if (expand && (next === 'c' || next === 'C' || next === 'M')) {
      this.#fail('it uses a control or meta escape (\\c, \\C-, \\M-), which depcurfew does not read', 'write the character another way, such as \\x01');
    }
    this.#i = i + 1 + (this.#width(i + 1));
    return 'other';
  }

  /** The number of UTF-16 units of the character at `at`. */
  #width(at: number): number {
    const code = this.#text.charCodeAt(at);
    return code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }

  #heredocStep(frame: HeredocFrame): void {
    const text = this.#text;
    const i = this.#i;
    if (!frame.expand) {
      const end = this.#lineEnd(i);
      if (end >= text.length) {
        this.#i = end;
        return;
      }
      this.#newline(end);
      return;
    }
    const c = text[i];
    if (c === '\n') {
      this.#newline(i);
      return;
    }
    if (c === '\\') {
      if (this.#escape(true) === 'newline') frame.continued = true;
      return;
    }
    if (c === '#') {
      const next = text[i + 1];
      if (next === '{') {
        this.#stack.push(this.#code(true));
        this.#i = i + 2;
        return;
      }
      if (next === '@' || next === '$') {
        const end = next === '@' ? this.#instanceEnd(i + 1) : this.#globalEnd(i + 1, true);
        if (end !== undefined) {
          this.#i = end;
          return;
        }
      }
    }
    this.#i = i + 1;
  }

  /** The end of a global variable at `at` ($): $foo, $1, $-w, $~ and the others of is_global_name_punct. */
  #globalEnd(at: number, interpolation = false): number | undefined {
    const text = this.#text;
    const c = text[at + 1];
    if (c === '-') {
      // In a string, #$- interpolates only before a letter, _ or a character beyond ASCII (parser_peek_variable_name).
      const name = text[at + 2];
      return (interpolation ? isIdentStart(name) : isIdentChar(name)) ? at + 2 + this.#width(at + 2) : undefined;
    }
    if (c !== undefined && GLOBAL_PUNCTUATION.has(c)) return at + 2;
    if (isDigit(c) && c !== '0') {
      let j = at + 1;
      while (isDigit(text[j])) j++;
      return j;
    }
    if (c === '0' || isIdentStart(c)) {
      let j = at + 1;
      while (isIdentChar(text[j])) j++;
      if (c === '0' && j > at + 2 && DIFFERENCES.globalZeroWithName) {
        this.#fail(
          `Ruby 3.3 and older (parse.y) read ${text.slice(at, j)} as one global variable, and Ruby 3.4 and newer (Prism) report a syntax error`,
          'write $0 apart from the name after it',
        );
      }
      return j;
    }
    return undefined;
  }

  /** The end of an instance or class variable at `at` (@): @foo, @@foo. */
  #instanceEnd(at: number): number | undefined {
    const text = this.#text;
    let j = at + 1;
    if (text[j] === '@') j++;
    if (!isIdentStart(text[j])) return undefined;
    while (isIdentChar(text[j])) j++;
    return j;
  }

  #questionMark(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    const next = text[i + 1];
    const ternary = (): void => {
      frame.ternary += 1;
      this.#token({ kind: 'op', text: '?', start: i, end: i + 1 }, frame);
      this.#i = i + 1;
      this.#after(frame, 'beg');
    };
    if (state === 'end') return ternary();
    if (state === 'dot' || state === 'fname') this.#fail('it calls or defines a method named ?, which depcurfew does not read', 'give the method a name of letters');
    if (next === undefined) this.#syntaxError('a ? at the end of the file');
    if (isRubySpace(next)) return ternary();
    if (state === 'ident') this.#ambiguous(this.#lastName(), '?');
    const width = this.#width(i + 1);
    if (DIFFERENCES.characterBeyondAscii && isNonAscii(next)) {
      const character = text.slice(i + 1, i + 1 + width);
      this.#fail(
        'Ruby 3.4 and newer (Prism) and Ruby 3.3 and older (parse.y) read ? before a character beyond ASCII differently, as a character literal or as the ? of a ternary',
        `write the character as a string ("${character}" in place of ?${character}), or put a space after the ? of a ternary`,
      );
    }
    if (isIdentChar(next) && isIdentChar(text[i + 1 + width])) return ternary();
    let end: number;
    if (next === '\\') {
      const escaped = text[i + 2];
      if (escaped === undefined || escaped === '\n') this.#syntaxError('an incomplete character literal');
      if (escaped === 'c' || escaped === 'C' || escaped === 'M') this.#fail('it uses a control or meta escape (?\\c, ?\\C-, ?\\M-), which depcurfew does not read', 'write the character another way, such as ?\\x01');
      if (escaped === 'u') {
        if (text[i + 3] === '{') {
          // One code point in hex digits between spaces (tokadd_utf8), read once: no search to the end of the line.
          let k = i + 4;
          while (isInlineSpace(text[k])) k++;
          const digits = k;
          while (/^[0-9a-fA-F]$/u.test(text[k] ?? '')) k++;
          const none = k === digits;
          while (isInlineSpace(text[k])) k++;
          if (none || text[k] !== '}') this.#syntaxError('a \\u{ escape that is not one code point in hex digits closed by }');
          end = k + 1;
        } else {
          end = i + 7;
        }
      } else if (escaped === 'x') {
        end = i + 3;
        while (end < i + 5 && /[0-9a-fA-F]/u.test(text[end] ?? '')) end++;
      } else if (escaped >= '0' && escaped <= '7') {
        end = i + 3;
        while (end < i + 5 && (text[end] ?? '') >= '0' && (text[end] ?? '') <= '7') end++;
      } else {
        end = i + 2 + this.#width(i + 2);
      }
    } else {
      end = i + 1 + width;
    }
    this.#token({ kind: 'other', text: text.slice(i, end), start: i, end }, frame);
    this.#i = end;
    this.#after(frame, 'end');
  }

  #percent(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    const next = text[i + 1];
    if (BEGINS.has(state)) return this.#percentLiteral(frame);
    if (next === '=') {
      this.#token({ kind: 'op', text: '%=', start: i, end: i + 2 }, frame);
      this.#i = i + 2;
      this.#after(frame, 'beg');
      return;
    }
    const spaced = frame.space && next !== undefined && !isRubySpace(next);
    if (state === 'arg' && spaced) return this.#percentLiteral(frame);
    if (state === 'ident' && spaced) this.#ambiguous(this.#lastName(), '%');
    this.#operator(frame);
  }

  #percentLiteral(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    let type = text[i + 1];
    let term: string | undefined;
    let content: number;
    if (type === undefined) this.#syntaxError('a % at the end of the file');
    if (!isAlnum(type)) {
      if (isNonAscii(type)) this.#syntaxError('an unknown type of %string');
      term = type;
      type = 'Q';
      content = i + 2;
    } else {
      term = text[i + 2];
      if (term === undefined || isAlnum(term) || isNonAscii(term) || !PERCENT_TYPES.has(type)) this.#syntaxError('an unknown type of %string');
      content = i + 3;
    }
    const close = PAIRS.get(term);
    this.#stack.push({
      kind: 'string',
      term: close ?? term,
      paren: close === undefined ? '' : term,
      nest: 0,
      expand: EXPANDING.has(type),
      regexp: type === 'r',
      label: false,
      quote: '',
      symbol: type === 's',
      start: i,
      line: this.#line,
      changed: true,
    });
    if (term === '\n') {
      if (this.#recording !== undefined) this.#recording.full = true;
      this.#newline(content - 1);
      return;
    }
    this.#i = content;
  }

  #slash(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    const next = text[i + 1];
    const regexp = (): void => this.#openString(frame, { term: '/', paren: '', expand: true, regexp: true, label: false, quote: '', symbol: false }, i + 1);
    if (BEGINS.has(state)) return regexp();
    if (next === '=') {
      this.#token({ kind: 'op', text: '/=', start: i, end: i + 2 }, frame);
      this.#i = i + 2;
      this.#after(frame, 'beg');
      return;
    }
    const spaced = frame.space && next !== undefined && !isRubySpace(next);
    if (state === 'arg' && spaced) return regexp();
    if (state === 'ident' && spaced) this.#ambiguous(this.#lastName(), '/');
    if (state === 'dot' || state === 'fname') this.#fail('it calls or defines a method named /, which depcurfew does not read', 'give the method a name of letters');
    this.#token({ kind: 'op', text: '/', start: i, end: i + 1 }, frame);
    this.#i = i + 1;
    this.#after(frame, 'beg');
  }

  /** The identifier of a heredoc that starts at `at` (after <<), or undefined when << is no heredoc there. */
  #heredocIdentifier(at: number): { id: string; indent: boolean; expand: boolean; end: number } | undefined {
    const text = this.#text;
    let j = at;
    let indent = false;
    if (HEREDOC_INDENT.has(text[j] ?? '')) {
      indent = true;
      j++;
    }
    const c = text[j];
    if (c === "'" || c === '"' || c === '`') {
      let k = j + 1;
      while (k < text.length && text[k] !== c) {
        if (text[k] === '\r' || text[k] === '\n') this.#syntaxError('an unterminated here document identifier');
        k++;
      }
      if (k >= text.length) this.#syntaxError('an unterminated here document identifier');
      return { id: text.slice(j + 1, k), indent, expand: c !== "'", end: k + 1 };
    }
    if (!isIdentChar(c)) return undefined;
    let k = j;
    while (isIdentChar(text[k])) k++;
    return { id: text.slice(j, k), indent, expand: true, end: k };
  }

  #lessThan(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    if (text[i + 1] === '<' && state !== 'dot' && state !== 'class' && state !== 'end') {
      const allowed = (state !== 'arg' && state !== 'ident') || frame.space;
      const heredoc = allowed ? this.#heredocIdentifier(i + 2) : undefined;
      if (heredoc !== undefined) {
        if (state === 'ident') this.#ambiguous(this.#lastName(), '<<');
        if (state === 'fname') this.#fail('it defines a method named <<, which depcurfew does not read', 'give the method a name of letters');
        this.#pending.push({ id: heredoc.id, indent: heredoc.indent, expand: heredoc.expand, line: this.#line });
        this.#token({ kind: 'other', text: text.slice(i, heredoc.end), start: i, end: heredoc.end }, frame);
        if (this.#recording !== undefined) this.#recording.full = true;
        this.#i = heredoc.end;
        this.#after(frame, 'end');
        return;
      }
    }
    if (state === 'dot' || state === 'fname') this.#fail('it calls or defines a method named by an operator, which depcurfew does not read', 'give the method a name of letters, or call the operator without a dot');
    const op = ['<<=', '<=>', '<<', '<=', '<'].find((candidate) => text.startsWith(candidate, i)) ?? '<';
    this.#token({ kind: 'op', text: op, start: i, end: i + op.length }, frame);
    this.#i = i + op.length;
    this.#after(frame, 'beg');
  }

  #colon(frame: CodeFrame): void {
    const text = this.#text;
    const i = this.#i;
    const state = frame.state;
    const next = text[i + 1];
    if (next === ':') {
      this.#operator(frame);
      return;
    }
    if (state === 'end' || next === undefined || isRubySpace(next) || next === '#') {
      if (frame.ternary > 0) frame.ternary -= 1;
      this.#token({ kind: 'op', text: ':', start: i, end: i + 1 }, frame);
      this.#i = i + 1;
      this.#after(frame, 'beg');
      return;
    }
    if (next === '"' || next === "'") {
      this.#openString(frame, { term: next, paren: '', expand: next === '"', regexp: false, label: false, quote: '', symbol: true }, i + 2);
      return;
    }
    // A symbol, unless : ends a ternary whose ? came after a name that may be a local variable.
    if (state === 'ident' && frame.ternary > 0) this.#ambiguous(this.#lastName(), ':');
    let end: number | undefined;
    if (isIdentStart(next)) {
      end = i + 1;
      while (isIdentChar(text[end])) end++;
      if ((text[end] === '?' || text[end] === '!') && text[end + 1] !== '=') end++;
      else if (text[end] === '=' && text[end + 1] !== '~' && text[end + 1] !== '>' && (text[end + 1] !== '=' || text[end + 2] === '>')) end++;
    } else if (next === '@') {
      end = this.#instanceEnd(i + 1);
    } else if (next === '$') {
      end = this.#globalEnd(i + 1);
    } else {
      const op = SYMBOL_OPERATORS.find((candidate) => text.startsWith(candidate, i + 1));
      if (op === '<<' && this.#heredocIdentifier(i + 3) !== undefined) this.#fail('a :<< there may start a heredoc, which depcurfew does not read', 'write the symbol as :"<<"');
      if ((op === '%' || op === '/') && text[i + 2] === '=') this.#syntaxError(`:${op}= is no symbol`);
      if (op !== undefined) end = i + 1 + op.length;
    }
    if (end === undefined) this.#syntaxError(`:${next} is no symbol`);
    this.#token({ kind: 'symbol', text: text.slice(i, end), start: i, end }, frame);
    this.#i = end;
    this.#after(frame, 'end');
  }
}

/** Reads a Gemfile as Ruby's lexer does (see the comment at the top). */
export function scanRuby(text: string, options: ScanOptions = {}): RubyScan {
  // Ruby reads \r\n as one newline everywhere, also in a literal delimited by \r (extra.rubySyntax lineEnding), so the
  // scanner reads the text with \n in its place, and every reader of a Gemfile, apply and doctor, gets the same reading.
  // Once only: a second pass would take the \r alone of \r\r\n, which apply's text (toLf) holds as \r\n.
  const read = options.newlinesRead === true || !text.includes(SYNTAX.lineEnding) ? text : text.replaceAll(SYNTAX.lineEnding, '\n');
  return new Scanner(read).run();
}

export interface ScanOptions {
  /**
   * The text has \r\n read as \n already, as the text apply edits (toLf in src/apply/text.ts, the same replacement):
   * it is read as it is. Otherwise, as for a file read from disk, \r\n is read as \n first.
   */
  newlinesRead?: boolean;
}

/**
 * The position in `original` of the position `at` of the text scanRuby read, which has \n in place of each \r\n of
 * `original`; `crs` are the positions of those \n in the text read, in order.
 */
export function originalPosition(crs: readonly number[], at: number): number {
  let low = 0;
  let high = crs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((crs[middle] ?? 0) < at) low = middle + 1;
    else high = middle;
  }
  return at + low;
}

/** The positions in the text scanRuby reads of the \n that stand for a \r\n of `original`. */
export function lineEndingPositions(original: string): number[] {
  const positions: number[] = [];
  let removed = 0;
  for (let at = original.indexOf(SYNTAX.lineEnding); at !== -1; at = original.indexOf(SYNTAX.lineEnding, at + SYNTAX.lineEnding.length)) {
    positions.push(at - removed);
    removed += SYNTAX.lineEnding.length - 1;
  }
  return positions;
}
