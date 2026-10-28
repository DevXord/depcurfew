import { SCHEMA_URL } from './defaults.ts';
import { policyShape } from './schema.ts';

/** JSON Schema (draft-07, the draft editors support best) generated from the policy definition. */
export function policyJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_URL,
    title: 'depgate policy',
    ...policyShape.toJsonSchema(),
  };
}

export function renderPolicyJsonSchema(): string {
  return `${JSON.stringify(policyJsonSchema(), null, 2)}\n`;
}
