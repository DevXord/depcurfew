import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectFacts } from '../../src/knowledge/facts.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../../src/knowledge/render.ts';
import { requiredFactPaths, TOOL_IDS } from '../../src/knowledge/schema.ts';
import { validateEnvironment, validateKnowledge } from '../../src/knowledge/validate.ts';

const today = new Date().toISOString().slice(0, 10);

describe('knowledge base', () => {
  it('covers every supported tool exactly once', () => {
    expect(knowledgeBase.map((tool) => tool.id)).toEqual(TOOL_IDS);
  });

  it('passes validation: every fact has an official source and a verification date', () => {
    expect(validateKnowledge(knowledgeBase, today)).toEqual([]);
  });

  it('passes validation for the environment facts as well', () => {
    expect(validateEnvironment(environment, today)).toEqual([]);
  });

  it('rejects an environment fact from a location that is not official for it', () => {
    const broken = structuredClone(environment);
    broken.volta.maintained = { ...broken.volta.maintained, source: 'https://example.com/volta' } as typeof broken.volta.maintained;
    expect(validateEnvironment(broken, today)).toEqual([
      { tool: 'environment', path: 'volta.maintained', message: 'source is not an official location for this tool: example.com/volta' },
    ]);
  });

  it.each(TOOL_IDS.map((id) => [id]))('%s defines every required fact', (id) => {
    const tool = knowledgeBase.find((entry) => entry.id === id);
    expect(tool).toBeDefined();
    const paths = collectFacts(tool ?? {}).map((entry) => entry.path);
    expect(requiredFactPaths(tool ?? { kind: 'package-manager' }).filter((path) => !paths.includes(path))).toEqual([]);
  });

  it('docs/knowledge.md is up to date (run `npm run docs:knowledge`)', () => {
    const document = readFileSync(new URL('../../docs/knowledge.md', import.meta.url), 'utf8');
    expect(document).toBe(renderKnowledgeMarkdown(knowledgeBase, environment));
  });
});
