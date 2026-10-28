import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectFacts } from '../../src/knowledge/facts.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../../src/knowledge/render.ts';
import { requiredFactPaths, TOOL_IDS } from '../../src/knowledge/schema.ts';
import { validateKnowledge } from '../../src/knowledge/validate.ts';

const today = new Date().toISOString().slice(0, 10);

describe('knowledge base', () => {
  it('covers every supported tool exactly once', () => {
    expect(knowledgeBase.map((tool) => tool.id)).toEqual(TOOL_IDS);
  });

  it('passes validation: every fact has an official source and a verification date', () => {
    expect(validateKnowledge(knowledgeBase, today)).toEqual([]);
  });

  it.each(TOOL_IDS.map((id) => [id]))('%s defines every required fact', (id) => {
    const tool = knowledgeBase.find((entry) => entry.id === id);
    expect(tool).toBeDefined();
    const paths = collectFacts(tool ?? {}).map((entry) => entry.path);
    expect(requiredFactPaths(tool ?? { kind: 'package-manager' }).filter((path) => !paths.includes(path))).toEqual([]);
  });

  it('docs/knowledge.md is up to date (run `npm run docs:knowledge`)', () => {
    const document = readFileSync(new URL('../../docs/knowledge.md', import.meta.url), 'utf8');
    expect(document).toBe(renderKnowledgeMarkdown(knowledgeBase));
  });
});
