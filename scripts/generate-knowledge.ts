// Regenerates docs/knowledge.md from src/knowledge/. Refuses to write if the knowledge base is invalid.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { environment } from '../src/knowledge/environment.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../src/knowledge/render.ts';
import { validateEnvironment, validateKnowledge } from '../src/knowledge/validate.ts';

const today = new Date().toISOString().slice(0, 10);
const issues = [...validateKnowledge(knowledgeBase, today), ...validateEnvironment(environment, today)];
if (issues.length > 0) {
  for (const issue of issues) console.error(`${issue.tool} ${issue.path}: ${issue.message}`);
  console.error(`Knowledge base has ${issues.length} issue(s); docs/knowledge.md was not written.`);
  process.exitCode = 1;
} else {
  const target = new URL('../docs/knowledge.md', import.meta.url);
  writeFileSync(target, renderKnowledgeMarkdown(knowledgeBase, environment));
  console.log(`Wrote ${fileURLToPath(target)}`);
}
