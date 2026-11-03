// A JSON reader for documents too large to parse whole (decision D-168): it reads the bytes as they come, checks the
// syntax as JSON.parse does, and keeps only the values a selection asks for, so that its memory follows what is kept,
// not the size of the document. The npm registry sends package documents of 74 MB (renovate, 2026-11-03), mostly
// readmes and the package.json of every version, of which depcurfew uses the dist-tags, the publish times and, of each
// version, its install scripts and deprecation.
//
// The selection sees each value of an object it entered by its path of keys, with the first byte of the value, and
// answers: enter it (an object, whose members it then sees), keep it (parsed with JSON.parse when it ends) or skip
// it. Arrays are never entered. Keys are read as JSON.parse reads them (escapes decoded); text that is not valid UTF-8
// is decoded as TextDecoder decodes it, with U+FFFD, as reading the whole document did. A byte order mark at the start
// is skipped, as TextDecoder skips it.

/** What becomes of a value: its members are read (an object), it is parsed and handed over, or it is passed over. */
export type Treatment = 'enter' | 'keep' | 'skip';

export interface JsonSelection {
  /** The treatment of the value at `path` (keys from the top; [] is the document), whose first byte is `first`. */
  treat(path: readonly string[], first: number): Treatment;
  /** A value that `treat` kept, parsed. */
  kept(path: readonly string[], value: unknown): void;
}

/** The text is not JSON, or it ended before its value did. */
export class JsonSyntaxError extends SyntaxError {}

/** The values kept would take more than the reader keeps. */
export class JsonKeptTooMuch extends Error {}

/** The longest key of an entered object that is read; a longer one is no key a selection asks for. */
const MAX_KEY_BYTES = 64 * 1024;

const Token = {
  None: 0,
  String: 1,
  Number: 2,
  Literal: 3,
} as const;
type Token = (typeof Token)[keyof typeof Token];

const Expect = {
  /** A value: the document, the value of a member, an element. */
  Value: 0,
  /** After {: a key or }. */
  KeyOrEnd: 1,
  /** After , in an object: a key. */
  Key: 2,
  Colon: 3,
  /** After a member or an element: , or the end of its container. */
  CommaOrEnd: 4,
  /** After [: a value or ]. */
  ValueOrEnd: 5,
  /** After the document: only whitespace. */
  Done: 6,
} as const;
type Expect = (typeof Expect)[keyof typeof Expect];

/** The states of a number: after -, after 0, in the integer, after ., in the fraction, after e, after its sign, in the exponent. */
const Digits = {
  Minus: 0,
  Zero: 1,
  Integer: 2,
  Point: 3,
  Fraction: 4,
  E: 5,
  ESign: 6,
  Exponent: 7,
} as const;
type Digits = (typeof Digits)[keyof typeof Digits];

interface Frame {
  array: boolean;
  /** The members of an entered object are given to the selection. */
  entered: boolean;
  path: readonly string[];
}

interface Capture {
  /** The depth of the stack when the kept value began. */
  depth: number;
  path: readonly string[];
  parts: Uint8Array[];
  /** Where the value begins in the current chunk. */
  start: number;
}

const decoder = new TextDecoder();

function whitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function digit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function hex(byte: number): boolean {
  return digit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

export class JsonSelector {
  private readonly stack: Frame[] = [];
  private expect: Expect = Expect.Value;
  private token: Token = Token.None;
  /** In a string: after \, and how many hex digits of \u are still to come. */
  private escaped = false;
  private unicode = 0;
  /** The string being read is a key of an entered object, whose bytes are collected (undefined: too long). */
  private keyParts: Uint8Array[] | undefined;
  private keyStart = 0;
  private keyBytes = 0;
  private readingKey = false;
  /** The key of the member whose value comes next, in an entered object (undefined when it is not read). */
  private key: string | undefined;
  private digits: Digits = Digits.Minus;
  private literal = '';
  private literalAt = 0;
  private capture: Capture | undefined;
  private keptBytes = 0;
  private bom = 0;
  private started = false;

  private readonly selection: JsonSelection;
  private readonly maxKept: number;

  /** `maxKept`: the most bytes of kept values, beyond which write throws JsonKeptTooMuch. */
  constructor(selection: JsonSelection, maxKept: number) {
    this.selection = selection;
    this.maxKept = maxKept;
  }

  /** Reads the next bytes of the document; throws JsonSyntaxError or JsonKeptTooMuch, or what the selection throws. */
  write(chunk: Uint8Array): void {
    let index = 0;
    // A byte order mark (EF BB BF) at the very start, maybe split between chunks.
    while (!this.started && index < chunk.length) {
      const byte = chunk[index] as number;
      if (byte === [0xef, 0xbb, 0xbf][this.bom]) {
        this.bom += 1;
        index += 1;
        if (this.bom === 3) this.started = true;
        continue;
      }
      if (this.bom > 0) throw new JsonSyntaxError('unexpected byte');
      this.started = true;
    }
    if (this.capture !== undefined) this.capture.start = index;
    if (this.keyParts !== undefined) this.keyStart = index;
    for (; index < chunk.length; index++) {
      const byte = chunk[index] as number;
      if (this.token === Token.String) {
        // The bulk of a document is text: run over it to the next quote, backslash or control character.
        if (!this.escaped && this.unicode === 0) {
          while (index < chunk.length) {
            const next = chunk[index] as number;
            if (next === 0x22 || next === 0x5c || next < 0x20) break;
            index += 1;
          }
          if (index === chunk.length) break;
        }
        this.stringByte(chunk[index] as number, chunk, index);
        continue;
      }
      if (this.token === Token.Number) {
        if (this.numberByte(byte)) continue;
        // The number ended before this byte, which is read again as what follows it.
        this.endNumber(chunk, index);
      } else if (this.token === Token.Literal) {
        if (byte !== this.literal.charCodeAt(this.literalAt)) throw new JsonSyntaxError('invalid literal');
        this.literalAt += 1;
        if (this.literalAt === this.literal.length) {
          this.token = Token.None;
          this.valueEnded(chunk, index + 1);
        }
        continue;
      }
      this.structural(byte, chunk, index);
    }
    this.carry(chunk);
  }

  /** The document ended: throws JsonSyntaxError when its value did not. */
  end(): void {
    if (this.token === Token.Number) this.endNumber(new Uint8Array(0), 0);
    if (this.expect !== Expect.Done || this.token !== Token.None || this.bom % 3 !== 0) throw new JsonSyntaxError('unexpected end of the document');
  }

  /** The bytes of this chunk that a kept value or a key read so far holds, kept for when it ends in a later one. */
  private carry(chunk: Uint8Array): void {
    if (this.capture !== undefined && this.capture.start < chunk.length) this.collect(chunk.subarray(this.capture.start));
    if (this.keyParts !== undefined && this.keyStart < chunk.length) this.collectKey(chunk.subarray(this.keyStart));
  }

  private collect(bytes: Uint8Array): void {
    if (this.capture === undefined) return;
    this.keptBytes += bytes.length;
    if (this.keptBytes > this.maxKept) throw new JsonKeptTooMuch('the values kept are too large');
    // A copy: the chunk may be reused by the stream.
    this.capture.parts.push(bytes.slice());
  }

  private collectKey(bytes: Uint8Array): void {
    if (this.keyParts === undefined) return;
    this.keyBytes += bytes.length;
    if (this.keyBytes > MAX_KEY_BYTES) {
      this.keyParts = undefined;
      return;
    }
    this.keyParts.push(bytes.slice());
  }

  private stringByte(byte: number, chunk: Uint8Array, index: number): void {
    if (this.unicode > 0) {
      if (!hex(byte)) throw new JsonSyntaxError('invalid \\u escape');
      this.unicode -= 1;
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (byte === 0x75) this.unicode = 4;
      else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(byte)) throw new JsonSyntaxError('invalid escape');
      return;
    }
    if (byte === 0x5c) {
      this.escaped = true;
      return;
    }
    if (byte < 0x20) throw new JsonSyntaxError('control character in a string');
    // The closing quote.
    this.token = Token.None;
    if (this.readingKey) {
      this.readingKey = false;
      this.key = this.endKey(chunk, index + 1);
      this.expect = Expect.Colon;
      return;
    }
    this.valueEnded(chunk, index + 1);
  }

  /** The key that ends before `end`, decoded as JSON.parse decodes it; undefined when it was too long to read. */
  private endKey(chunk: Uint8Array, end: number): string | undefined {
    if (this.keyParts === undefined) return undefined;
    this.collectKey(chunk.subarray(this.keyStart, end));
    const parts = this.keyParts;
    this.keyParts = undefined;
    if (parts === undefined) return undefined;
    return JSON.parse(decoder.decode(Buffer.concat(parts))) as string;
  }

  /** Whether `byte` goes on the number; false when the number ended before it (and the number is complete). */
  private numberByte(byte: number): boolean {
    switch (this.digits) {
      case Digits.Minus:
        if (byte === 0x30) this.digits = Digits.Zero;
        else if (digit(byte)) this.digits = Digits.Integer;
        else throw new JsonSyntaxError('invalid number');
        return true;
      case Digits.Zero:
      case Digits.Integer:
        if (digit(byte) && this.digits === Digits.Integer) return true;
        if (digit(byte)) throw new JsonSyntaxError('leading zero');
        if (byte === 0x2e) this.digits = Digits.Point;
        else if (byte === 0x65 || byte === 0x45) this.digits = Digits.E;
        else return false;
        return true;
      case Digits.Point:
        if (!digit(byte)) throw new JsonSyntaxError('invalid number');
        this.digits = Digits.Fraction;
        return true;
      case Digits.Fraction:
        if (digit(byte)) return true;
        if (byte === 0x65 || byte === 0x45) {
          this.digits = Digits.E;
          return true;
        }
        return false;
      case Digits.E:
        if (byte === 0x2b || byte === 0x2d) this.digits = Digits.ESign;
        else if (digit(byte)) this.digits = Digits.Exponent;
        else throw new JsonSyntaxError('invalid number');
        return true;
      case Digits.ESign:
        if (!digit(byte)) throw new JsonSyntaxError('invalid number');
        this.digits = Digits.Exponent;
        return true;
      case Digits.Exponent:
        return digit(byte);
    }
  }

  private endNumber(chunk: Uint8Array, end: number): void {
    if (this.digits === Digits.Minus || this.digits === Digits.Point || this.digits === Digits.E || this.digits === Digits.ESign) throw new JsonSyntaxError('invalid number');
    this.token = Token.None;
    this.valueEnded(chunk, end);
  }

  /** A byte outside strings, numbers and literals. */
  private structural(byte: number, chunk: Uint8Array, index: number): void {
    if (whitespace(byte)) return;
    switch (this.expect) {
      case Expect.Value:
      case Expect.ValueOrEnd:
        if (this.expect === Expect.ValueOrEnd && byte === 0x5d) {
          this.close(true, chunk, index);
          return;
        }
        this.startValue(byte, chunk, index);
        return;
      case Expect.KeyOrEnd:
      case Expect.Key:
        if (this.expect === Expect.KeyOrEnd && byte === 0x7d) {
          this.close(false, chunk, index);
          return;
        }
        if (byte !== 0x22) throw new JsonSyntaxError('expected a key');
        this.token = Token.String;
        this.readingKey = true;
        this.key = undefined;
        if (this.capture === undefined && this.stack.at(-1)?.entered === true) {
          this.keyParts = [];
          this.keyBytes = 0;
          this.keyStart = index;
        }
        return;
      case Expect.Colon:
        if (byte !== 0x3a) throw new JsonSyntaxError('expected :');
        this.expect = Expect.Value;
        return;
      case Expect.CommaOrEnd: {
        const frame = this.stack.at(-1);
        if (frame === undefined) throw new JsonSyntaxError('unexpected byte');
        if (byte === 0x2c) this.expect = frame.array ? Expect.Value : Expect.Key;
        else if (byte === (frame.array ? 0x5d : 0x7d)) this.close(frame.array, chunk, index);
        else throw new JsonSyntaxError('expected , or the end of the container');
        return;
      }
      case Expect.Done:
        throw new JsonSyntaxError('text after the document');
    }
  }

  private startValue(byte: number, chunk: Uint8Array, index: number): void {
    const parent = this.stack.at(-1);
    let treatment: Treatment = 'skip';
    let path: readonly string[] = [];
    if (this.capture === undefined && (parent === undefined || (parent.entered && !parent.array && this.key !== undefined))) {
      path = parent === undefined ? [] : [...parent.path, this.key as string];
      treatment = this.selection.treat(path, byte);
    }
    if (treatment === 'enter' && byte !== 0x7b) treatment = 'skip';
    if (treatment === 'keep') this.capture = { depth: this.stack.length, path, parts: [], start: index };
    if (byte === 0x7b) {
      this.stack.push({ array: false, entered: treatment === 'enter', path });
      this.expect = Expect.KeyOrEnd;
    } else if (byte === 0x5b) {
      this.stack.push({ array: true, entered: false, path });
      this.expect = Expect.ValueOrEnd;
    } else if (byte === 0x22) {
      this.token = Token.String;
    } else if (byte === 0x2d || digit(byte)) {
      this.token = Token.Number;
      this.digits = byte === 0x2d ? Digits.Minus : byte === 0x30 ? Digits.Zero : Digits.Integer;
    } else if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
      this.token = Token.Literal;
      this.literal = byte === 0x74 ? 'true' : byte === 0x66 ? 'false' : 'null';
      this.literalAt = 1;
    } else {
      throw new JsonSyntaxError('expected a value');
    }
  }

  private close(array: boolean, chunk: Uint8Array, index: number): void {
    const frame = this.stack.pop();
    if (frame === undefined || frame.array !== array) throw new JsonSyntaxError('unexpected end of a container');
    this.valueEnded(chunk, index + 1);
  }

  /** A value ended before `end` in `chunk`: hands a kept one over, and moves on in its container. */
  private valueEnded(chunk: Uint8Array, end: number): void {
    const capture = this.capture;
    if (capture !== undefined && capture.depth === this.stack.length) {
      this.collect(chunk.subarray(capture.start, end));
      this.capture = undefined;
      this.selection.kept(capture.path, JSON.parse(decoder.decode(Buffer.concat(capture.parts))) as unknown);
    }
    this.expect = this.stack.length === 0 ? Expect.Done : Expect.CommaOrEnd;
  }
}
