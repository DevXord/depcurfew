// Regenerates schema.json (published with the package) from the policy definition in src/policy/schema.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPolicyJsonSchema } from '../src/policy/json-schema.ts';

const target = new URL('../schema.json', import.meta.url);
writeFileSync(target, renderPolicyJsonSchema());
console.log(`Wrote ${fileURLToPath(target)}`);
