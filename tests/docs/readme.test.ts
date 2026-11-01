// README.md: the generated sections match the sources, and the hand-written text states no package manager
// facts of its own (no setting name from the knowledge base appears outside the generated sections).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTION_RELEASE, handWritten, renderReadme } from '../../src/docs/readme.ts';
import { compareVersions, parseVersion } from '../../src/apply/version.ts';
import { values } from '../../src/apply/facts.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { collectFacts } from '../../src/knowledge/facts.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { policyJsonSchema } from '../../src/policy/json-schema.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const inputs = { tools: knowledgeBase, environment, action: read('action.yml'), workflow: read('.github/workflows/ci.yml') };

/** Field names of depcurfew.json, which the README may use freely even where a tool has a setting of that name. */
function policyFields(schema: unknown, names = new Set<string>()): Set<string> {
  if (typeof schema === 'object' && schema !== null) {
    const properties = (schema as Record<string, unknown>)['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [name, child] of Object.entries(properties)) {
        names.add(name);
        policyFields(child, names);
      }
    }
  }
  return names;
}

/** Every setting name in the knowledge base (facts whose path ends in "setting"). */
function settingNames(): string[] {
  const names = new Set<string>();
  for (const tool of knowledgeBase) {
    for (const entry of collectFacts(tool)) {
      if (!/(^|\.)setting$/u.test(entry.path)) continue;
      for (const value of values(entry.fact)) {
        if (typeof value === 'string' && !value.includes(' ')) names.add(value);
      }
    }
  }
  const allowed = policyFields(policyJsonSchema());
  return [...names].filter((name) => !allowed.has(name));
}

describe('README.md', () => {
  it('is up to date (run npm run docs:readme)', () => {
    expect(renderReadme(readme, inputs)).toBe(readme);
  });

  it('finds the setting names to check', () => {
    expect(settingNames()).toEqual(expect.arrayContaining(['min-release-age', 'minimumReleaseAge', 'npmMinimalAgeGate', 'trustedDependencies']));
  });

  it('names no package manager setting outside the generated sections', () => {
    const text = handWritten(readme);
    for (const name of settingNames()) {
      const pattern = new RegExp(`(^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^\\w-])`, 'u');
      expect(pattern.test(text), `README mentions ${name} outside a generated section`).toBe(false);
    }
  });

  it('says npm skips the project .npmrc in global mode only while the knowledge base says so', () => {
    const fact = knowledgeBase.find((tool) => tool.id === 'npm')?.extra?.['npmrcScope'];
    const scope = fact === undefined ? undefined : (values(fact)[0] as Record<string, unknown> | undefined);
    expect(readme.includes("npm does not read the project's `.npmrc` in global mode")).toBe(scope?.['globalMode'] === 'ignored');
  });

  it('links only to URLs and anchors, because the README on npmjs.com cannot open files of the repository', () => {
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1] ?? '');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !target.startsWith('https://') && !target.startsWith('#'))).toEqual([]);
    expect(readme).not.toMatch(/See `src\//u);
  });

  it('keeps the generated sections between markers', () => {
    for (const name of ['default-policy', 'policy-fields', 'tools', 'rules', 'action-workflow', 'action-reference', 'claude-code-hook', 'mcp-clients', 'user-config', 'user-rules']) {
      expect(readme).toContain(`<!-- BEGIN GENERATED: ${name} -->`);
      expect(readme).toContain(`<!-- END GENERATED: ${name} -->`);
    }
  });

  it('pins the action in the example workflow to the full commit of a release, named by its tag', () => {
    expect(ACTION_RELEASE.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(readme).toContain(`      - uses: DevXord/depcurfew@${ACTION_RELEASE.commit} # v${ACTION_RELEASE.version}\n`);
    // A release that already exists: never newer than the version being prepared in package.json.
    const released = parseVersion(ACTION_RELEASE.version);
    const current = parseVersion((JSON.parse(read('package.json')) as { version: string }).version);
    expect(released).toBeDefined();
    expect(current).toBeDefined();
    expect(compareVersions(released!, current!)).toBeLessThanOrEqual(0);
  });
});
