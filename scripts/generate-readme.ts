// Rewrites the generated sections of README.md from the knowledge base, the policy definition, the doctor rules
// and action.yml. The hand-written text between them is left as it is.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderReadme } from '../src/docs/readme.ts';
import { environment } from '../src/knowledge/environment.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';

const target = new URL('../README.md', import.meta.url);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
writeFileSync(
  target,
  renderReadme(readFileSync(target, 'utf8'), {
    tools: knowledgeBase,
    environment,
    action: read('action.yml'),
    workflow: read('.github/workflows/ci.yml'),
  }),
);
console.log(`Wrote ${fileURLToPath(target)}`);
