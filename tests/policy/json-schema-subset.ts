// A minimal JSON Schema (draft-07) evaluator for the keywords depgate's generator emits. It exists only to check
// that schema.json accepts and rejects the same documents as the validator, without adding a dependency.
// Any other keyword throws, so the generator cannot start emitting something this evaluator ignores.

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples']);
const ASSERTIONS = new Set([
  'type',
  'const',
  'enum',
  'pattern',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'uniqueItems',
  'minItems',
  'anyOf',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new Error(`unsupported type ${JSON.stringify(type)}`);
  }
}

export function matchesSchema(schema: Schema, value: unknown): boolean {
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !ASSERTIONS.has(key)) throw new Error(`unsupported keyword ${key}`);
  }
  if ('type' in schema && !hasType(value, schema['type'])) return false;
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema['const'])) return false;
  if ('enum' in schema && !(schema['enum'] as unknown[]).some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return false;
  }
  if ('pattern' in schema && typeof value === 'string' && !new RegExp(schema['pattern'] as string, 'u').test(value)) {
    return false;
  }
  if ('anyOf' in schema && !(schema['anyOf'] as Schema[]).some((branch) => matchesSchema(branch, value))) return false;

  if (isObject(value)) {
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const name of (schema['required'] ?? []) as string[]) {
      if (!(name in value)) return false;
    }
    for (const [name, child] of Object.entries(value)) {
      const property = properties[name];
      if (property !== undefined) {
        if (!matchesSchema(property, child)) return false;
      } else if (schema['additionalProperties'] === false) {
        return false;
      } else if ('additionalProperties' in schema) {
        throw new Error('only additionalProperties: false is supported');
      }
    }
  }

  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < (schema['minItems'] as number)) return false;
    if (schema['uniqueItems'] === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if ('items' in schema && !value.every((item) => matchesSchema(schema['items'] as Schema, item))) return false;
  }
  return true;
}
