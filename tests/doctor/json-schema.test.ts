// The test-only JSON Schema validator must reject what it should, or the SARIF check below proves nothing.
import { describe, expect, it } from 'vitest';
import { JsonSchemaValidator } from '../support/json-schema.ts';

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['version', 'runs'],
  additionalProperties: false,
  properties: {
    version: { enum: ['2.1.0'] },
    runs: { type: 'array', minItems: 1, items: { $ref: '#/definitions/run' } },
  },
  definitions: {
    run: {
      type: 'object',
      properties: {
        level: { enum: ['error', 'warning'] },
        line: { type: 'integer', minimum: 1 },
        uri: { type: 'string', format: 'uri-reference' },
        tags: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      dependencies: { line: ['uri'] },
    },
  },
};

describe('JsonSchemaValidator', () => {
  const validator = new JsonSchemaValidator(schema);

  it('accepts a valid document', () => {
    expect(validator.validate({ version: '2.1.0', runs: [{ level: 'error', line: 3, uri: 'a.json', tags: ['x'], choice: 1 }] })).toEqual([]);
  });

  it.each([
    [{ runs: [{}] }, '$: missing required property "version"'],
    [{ version: '2.0.0', runs: [{}] }, '$.version: must be one of ["2.1.0"]'],
    [{ version: '2.1.0', runs: [] }, '$.runs: must have at least 1 items'],
    [{ version: '2.1.0', runs: [{}], extra: 1 }, '$.extra: no value is allowed here'],
    [{ version: '2.1.0', runs: [{ line: 0, uri: 'a' }] }, '$.runs[0].line: must be at least 1'],
    [{ version: '2.1.0', runs: [{ line: 1.5, uri: 'a' }] }, '$.runs[0].line: expected integer, got number'],
    [{ version: '2.1.0', runs: [{ line: 2 }] }, '$.runs[0]: "line" requires "uri"'],
    [{ version: '2.1.0', runs: [{ tags: ['a', 'a'] }] }, '$.runs[0].tags: items must be unique'],
    [{ version: '2.1.0', runs: [{ tags: [''] }] }, '$.runs[0].tags[0]: must have at least 1 characters'],
    [{ version: '2.1.0', runs: [{ choice: true }] }, '$.runs[0].choice: matches 0 of oneOf, expected exactly 1'],
  ])('rejects %j', (document, message) => {
    expect(validator.validate(document)).toContain(message);
  });

  it('throws on a keyword it does not implement', () => {
    expect(() => new JsonSchemaValidator({ type: 'object', if: {} }).validate({})).toThrow('unsupported JSON Schema keyword "if"');
  });
});
