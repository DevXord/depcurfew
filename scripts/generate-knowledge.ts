// Regenerates docs/knowledge.md from src/knowledge/. Refuses to write if the knowledge base is invalid.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { knowledgeBase } from '../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../src/knowledge/render.ts';
import { validateKnowledge } from '../src/knowledge/validate.ts';

const issues = validateKnowledge(knowledgeBase, new Date().toISOString().slice(0, 10));
if (issues.length > 0) {
  for (const issue of issues) console.error(`${issue.tool} ${issue.path}: ${issue.message}`);
  console.error(`Knowledge base has ${issues.length} issue(s); docs/knowledge.md was not written.`);
  process.exitCode = 1;
} else {
  const target = new URL('../docs/knowledge.md', import.meta.url);
  writeFileSync(target, renderKnowledgeMarkdown(knowledgeBase));
  console.log(`Wrote ${fileURLToPath(target)}`);
}
