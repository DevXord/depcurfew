// A small JSON Schema (draft-04 to draft-07) validator for tests, written here because the project takes no
// dependencies without the owner's approval. It is strict about the schema: a keyword it does not implement throws,
// so a schema can never pass validation by being only partly understood.

type Schema = boolean | Record<string, unknown>;

const ANNOTATIONS = new Set(['$schema', '$id', 'id', 'title', 'description', 'default', 'examples', '$comment', 'definitions', 'deprecated']);
const KEYWORDS = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'dependencies',
  'items',
  'additionalItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const FORMATS: Record<string, (value: string) => boolean> = {
  uri: (value) => /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value),
  'uri-reference': () => true,
  'date-time': (value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/u.test(value),
};

export class JsonSchemaValidator {
  readonly #root: Record<string, unknown>;

  constructor(root: Record<string, unknown>) {
    this.#root = root;
  }

  #resolve(reference: string): Schema {
    if (!reference.startsWith('#')) throw new Error(`unsupported $ref ${reference}`);
    let node: unknown = this.#root;
    for (const part of reference.slice(1).split('/').filter(Boolean)) {
      node = (node as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    if (typeof node !== 'object' && typeof node !== 'boolean') throw new Error(`unresolved $ref ${reference}`);
    return node as Schema;
  }

  /** Returns every violation as "path: message"; empty when the value is valid. */
  validate(value: unknown, schema: Schema = this.#root, path = '$'): string[] {
    if (schema === true) return [];
    if (schema === false) return [`${path}: no value is allowed here`];
    for (const keyword of Object.keys(schema)) {
      if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) throw new Error(`unsupported JSON Schema keyword "${keyword}" at ${path}`);
    }
    const errors: string[] = [];
    const fail = (message: string) => errors.push(`${path}: ${message}`);

    if (typeof schema['$ref'] === 'string') return this.validate(value, this.#resolve(schema['$ref']), path);

    const type = schema['type'];
    if (type !== undefined) {
      const types = Array.isArray(type) ? (type as string[]) : [type as string];
      if (!types.some((candidate) => matchesType(value, candidate))) {
        fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`);
        return errors;
      }
    }
    if (Array.isArray(schema['enum']) && !schema['enum'].some((item) => equal(item, value))) fail(`must be one of ${JSON.stringify(schema['enum'])}`);
    if ('const' in schema && !equal(schema['const'], value)) fail(`must be ${JSON.stringify(schema['const'])}`);

    if (typeOf(value) === 'object') errors.push(...this.#object(value as Record<string, unknown>, schema, path));
    if (Array.isArray(value)) errors.push(...this.#array(value, schema, path));
    if (typeof value === 'number') {
      if (typeof schema['minimum'] === 'number' && value < schema['minimum']) fail(`must be at least ${schema['minimum']}`);
      if (typeof schema['maximum'] === 'number' && value > schema['maximum']) fail(`must be at most ${schema['maximum']}`);
      if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) fail(`must be above ${schema['exclusiveMinimum']}`);
      if (typeof schema['exclusiveMaximum'] === 'number' && value >= schema['exclusiveMaximum']) fail(`must be below ${schema['exclusiveMaximum']}`);
      if (typeof schema['multipleOf'] === 'number' && value % schema['multipleOf'] !== 0) fail(`must be a multiple of ${schema['multipleOf']}`);
    }
    if (typeof value === 'string') {
      if (typeof schema['minLength'] === 'number' && [...value].length < schema['minLength']) fail(`must have at least ${schema['minLength']} characters`);
      if (typeof schema['maxLength'] === 'number' && [...value].length > schema['maxLength']) fail(`must have at most ${schema['maxLength']} characters`);
      if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) fail(`must match ${schema['pattern']}`);
      const format = schema['format'];
      if (typeof format === 'string') {
        const check = FORMATS[format];
        if (check === undefined) throw new Error(`unsupported format "${format}" at ${path}`);
        if (!check(value)) fail(`must be a valid ${format}`);
      }
    }

    if (Array.isArray(schema['allOf'])) for (const part of schema['allOf'] as Schema[]) errors.push(...this.validate(value, part, path));
    if (Array.isArray(schema['anyOf']) && !(schema['anyOf'] as Schema[]).some((part) => this.validate(value, part, path).length === 0)) {
      fail('matches none of anyOf');
    }
    if (Array.isArray(schema['oneOf'])) {
      const matching = (schema['oneOf'] as Schema[]).filter((part) => this.validate(value, part, path).length === 0).length;
      if (matching !== 1) fail(`matches ${matching} of oneOf, expected exactly 1`);
    }
    if (schema['not'] !== undefined && this.validate(value, schema['not'] as Schema, path).length === 0) fail('matches a schema it must not match');
    return errors;
  }

  #object(value: Record<string, unknown>, schema: Record<string, unknown>, path: string): string[] {
    const errors: string[] = [];
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const patterns = Object.entries((schema['patternProperties'] ?? {}) as Record<string, Schema>).map(
      ([pattern, part]) => [new RegExp(pattern, 'u'), part] as const,
    );
    for (const name of (schema['required'] ?? []) as string[]) {
      if (!(name in value)) errors.push(`${path}: missing required property "${name}"`);
    }
    if (typeof schema['minProperties'] === 'number' && Object.keys(value).length < schema['minProperties']) {
      errors.push(`${path}: must have at least ${schema['minProperties']} properties`);
    }
    for (const [name, child] of Object.entries(value)) {
      const childPath = `${path}.${name}`;
      let matched = false;
      if (name in properties) {
        matched = true;
        errors.push(...this.validate(child, properties[name] as Schema, childPath));
      }
      for (const [pattern, part] of patterns) {
        if (pattern.test(name)) {
          matched = true;
          errors.push(...this.validate(child, part, childPath));
        }
      }
      if (!matched && schema['additionalProperties'] !== undefined) {
        errors.push(...this.validate(child, schema['additionalProperties'] as Schema, childPath));
      }
      if (schema['propertyNames'] !== undefined) errors.push(...this.validate(name, schema['propertyNames'] as Schema, `${childPath} (name)`));
    }
    for (const [name, dependency] of Object.entries((schema['dependencies'] ?? {}) as Record<string, unknown>)) {
      if (!(name in value)) continue;
      if (Array.isArray(dependency)) {
        for (const other of dependency as string[]) if (!(other in value)) errors.push(`${path}: "${name}" requires "${other}"`);
      } else {
        errors.push(...this.validate(value, dependency as Schema, path));
      }
    }
    return errors;
  }

  #array(value: unknown[], schema: Record<string, unknown>, path: string): string[] {
    const errors: string[] = [];
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) errors.push(`${path}: must have at least ${schema['minItems']} items`);
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) errors.push(`${path}: must have at most ${schema['maxItems']} items`);
    if (schema['uniqueItems'] === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path}: items must be unique`);
    }
    const items = schema['items'];
    if (Array.isArray(items)) {
      value.forEach((item, index) => {
        const part = (items as Schema[])[index] ?? (schema['additionalItems'] as Schema | undefined);
        if (part !== undefined) errors.push(...this.validate(item, part, `${path}[${index}]`));
      });
    } else if (items !== undefined) {
      value.forEach((item, index) => errors.push(...this.validate(item, items as Schema, `${path}[${index}]`)));
    }
    return errors;
  }
}
