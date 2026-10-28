// A small schema language: one definition gives the runtime validator (with readable errors and the path to the
// field), the TypeScript types (input as written in the file, output after defaults and parsing) and JSON Schema.

export interface Issue {
  /** Path to the field, e.g. `cooldown.exclude[2]`; `(root)` for the document itself. */
  path: string;
  message: string;
}

export type Path = readonly (string | number)[];

type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** The JSON Schema keywords this module emits. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number';
  description?: string;
  const?: string | number;
  enum?: readonly string[];
  pattern?: string;
  examples?: readonly unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  uniqueItems?: true;
  minItems?: number;
  anyOf?: JsonSchema[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false };

export interface Shape<In, Out = In> {
  /** How the shape is named in messages: `must be ${label}`. */
  readonly label: string;
  /** JSON types this shape can accept; a union picks its branch by the type of the value. */
  readonly jsonTypes: readonly JsonType[];
  /** Candidate values for "did you mean" suggestions. */
  readonly suggestions?: readonly string[];
  parse(value: unknown, path: Path, issues: Issue[]): ParseResult<Out>;
  toJsonSchema(): JsonSchema;
  /** Type-level only: the input type. */
  readonly __input?: In;
}

export type Input<S> = S extends Shape<infer In, unknown> ? In : never;
export type Output<S> = S extends Shape<unknown, infer Out> ? Out : never;

// Paths and messages

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

export function formatPath(path: Path): string {
  let text = '';
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) text += text === '' ? segment : `.${segment}`;
    else text += `[${JSON.stringify(segment)}]`;
  }
  return text === '' ? '(root)' : text;
}

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'object' || type === 'string' || type === 'number' || type === 'boolean' ? type : 'null';
}

/** Shows what was found: scalars as JSON, compound values by kind. */
export function describeValue(value: unknown): string {
  switch (jsonTypeOf(value)) {
    case 'array':
      return 'a list';
    case 'object':
      return 'an object';
    default:
      return JSON.stringify(value) ?? String(value);
  }
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => rows[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      (rows[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/** The closest candidate to a mistyped name, if one is close enough to be a likely typo. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  const normalize = (text: string) => text.toLowerCase().replace(/[-_\s]/gu, '');
  const wanted = normalize(input);
  const exact = candidates.find((candidate) => normalize(candidate) === wanted);
  if (exact !== undefined) return exact;
  const prefix = candidates.find((candidate) => {
    const name = normalize(candidate);
    return Math.min(name.length, wanted.length) >= 3 && (name.startsWith(wanted) || wanted.startsWith(name));
  });
  if (prefix !== undefined) return prefix;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, normalize(candidate));
    if (distance <= Math.max(1, Math.floor(candidate.length / 3)) && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function didYouMean(value: unknown, candidates: readonly string[] | undefined): string {
  if (typeof value !== 'string' || candidates === undefined) return '';
  const match = suggest(value, candidates);
  return match === undefined ? '' : `; did you mean ${JSON.stringify(match)}?`;
}

function report(issues: Issue[], path: Path, message: string): { ok: false } {
  issues.push({ path: formatPath(path), message });
  return { ok: false };
}

function mismatch(issues: Issue[], path: Path, label: string, value: unknown, candidates?: readonly string[]): { ok: false } {
  return report(issues, path, `must be ${label}, got ${describeValue(value)}${didYouMean(value, candidates)}`);
}

function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  return description === undefined ? schema : { description, ...schema };
}

// Scalars

interface Described {
  description?: string;
}

export function literal<const T extends string | number>(value: T, options: Described = {}): Shape<T> {
  const label = JSON.stringify(value);
  return {
    label,
    jsonTypes: [typeof value === 'string' ? 'string' : 'number'],
    ...(typeof value === 'string' ? { suggestions: [value] } : {}),
    parse: (input, path, issues) =>
      input === value ? { ok: true, value } : mismatch(issues, path, label, input, typeof value === 'string' ? [value] : undefined),
    toJsonSchema: () => {
      const type = typeof value === 'string' ? 'string' : Number.isInteger(value) ? 'integer' : 'number';
      return withDescription({ type, const: value }, options.description);
    },
  };
}

export function oneOfStrings<const T extends readonly string[]>(values: T, options: Described = {}): Shape<T[number]> {
  const label = `one of ${values.map((value) => JSON.stringify(value)).join(', ')}`;
  return {
    label,
    jsonTypes: ['string'],
    suggestions: values,
    parse: (input, path, issues) =>
      typeof input === 'string' && values.includes(input) ? { ok: true, value: input } : mismatch(issues, path, label, input, values),
    toJsonSchema: () => withDescription({ type: 'string', enum: values }, options.description),
  };
}

export interface TextOptions<Out> extends Described {
  label: string;
  /** Prefix of every message about an invalid string, e.g. `invalid duration`. */
  kind: string;
  pattern: string;
  examples?: readonly string[];
  /** Turns a string into the output value, or explains why it is invalid. */
  parse(text: string): { ok: true; value: Out } | { ok: false; message: string };
}

/** A string with its own syntax; the JSON Schema `pattern` must accept exactly the canonical form. */
export function text<Out>(options: TextOptions<Out>): Shape<string, Out> {
  return {
    label: options.label,
    jsonTypes: ['string'],
    parse(input, path, issues) {
      if (typeof input !== 'string') return mismatch(issues, path, options.label, input);
      const result = options.parse(input);
      return result.ok ? result : report(issues, path, `${options.kind} ${JSON.stringify(input)}: ${result.message}`);
    },
    toJsonSchema: () =>
      withDescription(
        { type: 'string', pattern: options.pattern, ...(options.examples === undefined ? {} : { examples: options.examples }) },
        options.description,
      ),
  };
}

export function anyString(options: Described = {}): Shape<string> {
  return {
    label: 'a string',
    jsonTypes: ['string'],
    parse: (input, path, issues) => (typeof input === 'string' ? { ok: true, value: input } : mismatch(issues, path, 'a string', input)),
    toJsonSchema: () => withDescription({ type: 'string' }, options.description),
  };
}

// Lists

export interface ListOptions extends Described {
  label?: string;
  /** Report repeated entries. */
  unique?: boolean;
  /** Reject an empty list; the text is appended to the message. */
  nonEmpty?: string;
}

export function list<In, Out>(item: Shape<In, Out>, options: ListOptions = {}): Shape<readonly In[], readonly Out[]> {
  const label = options.label ?? 'a list';
  return {
    label,
    jsonTypes: ['array'],
    parse(input, path, issues) {
      if (!Array.isArray(input)) return mismatch(issues, path, label, input);
      if (options.nonEmpty !== undefined && input.length === 0) {
        return report(issues, path, `must not be an empty list; ${options.nonEmpty}`);
      }
      const values: Out[] = [];
      const firstIndex = new Map<string, number>();
      let ok = true;
      input.forEach((element: unknown, index) => {
        const result = item.parse(element, [...path, index], issues);
        if (!result.ok) {
          ok = false;
          return;
        }
        if (options.unique === true) {
          const key = JSON.stringify(element);
          const first = firstIndex.get(key);
          if (first !== undefined) {
            ok = false;
            report(issues, [...path, index], `duplicate entry ${describeValue(element)} (first at index ${first})`);
            return;
          }
          firstIndex.set(key, index);
        }
        values.push(result.value);
      });
      return ok ? { ok: true, value: values } : { ok: false };
    },
    toJsonSchema: () =>
      withDescription(
        {
          type: 'array',
          items: item.toJsonSchema(),
          ...(options.unique === true ? { uniqueItems: true } : {}),
          ...(options.nonEmpty === undefined ? {} : { minItems: 1 }),
        },
        options.description,
      ),
  };
}

// Unions

/** Alternatives told apart by JSON type, e.g. `"auto"` or a list of tools. */
export function anyOf<const S extends readonly Shape<unknown, unknown>[]>(
  shapes: S,
  options: Described = {},
): Shape<Input<S[number]>, Output<S[number]>> {
  const types = shapes.flatMap((shape) => shape.jsonTypes);
  if (new Set(types).size !== types.length) throw new Error('anyOf alternatives must accept different JSON types');
  const label = shapes.map((shape) => shape.label).join(' or ');
  const suggestions = shapes.flatMap((shape) => shape.suggestions ?? []);
  return {
    label,
    jsonTypes: types,
    suggestions,
    parse(input, path, issues) {
      const shape = shapes.find((candidate) => candidate.jsonTypes.includes(jsonTypeOf(input)));
      if (shape === undefined) return mismatch(issues, path, label, input, suggestions);
      const own: Issue[] = [];
      const result = shape.parse(input, path, own);
      // A failure of the alternative as a whole is reported with every alternative; nested failures stay as they are.
      if (own.some((issue) => issue.path === formatPath(path) && issue.message.startsWith('must be '))) {
        return mismatch(issues, path, label, input, suggestions);
      }
      issues.push(...own);
      return result as ParseResult<Output<S[number]>>;
    },
    toJsonSchema: () => withDescription({ anyOf: shapes.map((shape) => shape.toJsonSchema()) }, options.description),
  };
}

// Objects

type FieldKind = 'required' | 'optional' | 'default';

export interface Field<In, Out, K extends FieldKind> {
  kind: K;
  shape: Shape<In, Out>;
  default?: In;
}

export function required<In, Out>(shape: Shape<In, Out>): Field<In, Out, 'required'> {
  return { kind: 'required', shape };
}

/** Absent fields stay absent in the output. */
export function optional<In, Out>(shape: Shape<In, Out>): Field<In, Out, 'optional'> {
  return { kind: 'optional', shape };
}

/** Absent fields get the default, parsed like a written value. */
export function withDefault<In, Out>(shape: Shape<In, Out>, value: NoInfer<In>): Field<In, Out, 'default'> {
  return { kind: 'default', shape, default: value };
}

type Fields = Record<string, Field<unknown, unknown, FieldKind>>;
type FieldInput<F> = F extends Field<infer In, unknown, FieldKind> ? In : never;
type FieldOutput<F> = F extends Field<unknown, infer Out, FieldKind> ? Out : never;
type KeysOf<F extends Fields, K extends FieldKind> = { [Key in keyof F]: F[Key] extends Field<unknown, unknown, K> ? Key : never }[keyof F];
type Simplify<T> = { [Key in keyof T]: T[Key] } & {};

export type ObjectInput<F extends Fields> = Simplify<
  { [Key in KeysOf<F, 'required'>]: FieldInput<F[Key]> } & { [Key in KeysOf<F, 'optional' | 'default'>]?: FieldInput<F[Key]> }
>;
export type ObjectOutput<F extends Fields> = Simplify<
  { [Key in KeysOf<F, 'required' | 'default'>]: FieldOutput<F[Key]> } & { [Key in KeysOf<F, 'optional'>]?: FieldOutput<F[Key]> }
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return jsonTypeOf(value) === 'object';
}

/** An object with known fields only; unknown fields are reported, with a suggestion when one looks like a typo. */
export function object<const F extends Fields>(fields: F, options: Described = {}): Shape<ObjectInput<F>, ObjectOutput<F>> {
  const names = Object.keys(fields);
  return {
    label: 'an object',
    jsonTypes: ['object'],
    parse(input, path, issues) {
      if (!isPlainObject(input)) return mismatch(issues, path, 'an object', input);
      let ok = true;
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(fields, key)) {
          ok = false;
          report(issues, path, `unknown field ${JSON.stringify(key)}${didYouMean(key, names)}`);
        }
      }
      const output: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields) as [string, Field<unknown, unknown, FieldKind>][]) {
        if (!Object.hasOwn(input, key)) {
          if (field.kind === 'required') {
            ok = false;
            report(issues, path, `missing required field ${JSON.stringify(key)}`);
          } else if (field.kind === 'default') {
            const result = field.shape.parse(field.default, [...path, key], issues);
            if (result.ok) output[key] = result.value;
          }
          continue;
        }
        const result = field.shape.parse(input[key], [...path, key], issues);
        if (result.ok) output[key] = result.value;
        else ok = false;
      }
      return ok ? { ok: true, value: output as ObjectOutput<F> } : { ok: false };
    },
    toJsonSchema() {
      const properties: Record<string, JsonSchema> = {};
      const requiredNames: string[] = [];
      for (const [key, field] of Object.entries(fields) as [string, Field<unknown, unknown, FieldKind>][]) {
        properties[key] = field.kind === 'default' ? { ...field.shape.toJsonSchema(), default: field.default } : field.shape.toJsonSchema();
        if (field.kind === 'required') requiredNames.push(key);
      }
      return withDescription(
        { type: 'object', properties, ...(requiredNames.length > 0 ? { required: requiredNames } : {}), additionalProperties: false },
        options.description,
      );
    },
  };
}
