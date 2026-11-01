import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, SCHEMA_URL } from '../../src/policy/defaults.ts';
import { parseDuration } from '../../src/policy/duration.ts';
import { policyJsonSchema, renderPolicyJsonSchema } from '../../src/policy/json-schema.ts';
import { validatePackagePattern } from '../../src/policy/package-pattern.ts';
import { validateProjectDirectory } from '../../src/policy/project-directory.ts';
import { parsePolicy, validatePolicy } from '../../src/policy/validate.ts';
import { policyFixtureNames, readFixture } from './fixture-files.ts';
import { matchesSchema } from './json-schema-subset.ts';

const root = new URL('../../', import.meta.url);
const schema = policyJsonSchema() as Record<string, unknown>;

// Checks that need code: arithmetic limits and rules that span several fields.
const VALIDATOR_ONLY = new Set(['duration-too-large', 'dependabot-over-maximum', 'allow-list-without-effect', 'deny-list-without-effect', 'allow-and-deny-overlap', 'allow-and-deny-patterns-overlap', 'projects-overlap']);

function walkSchemas(node: unknown, visit: (schema: Record<string, unknown>, path: string) => void, path = '#'): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const schemaNode = node as Record<string, unknown>;
  visit(schemaNode, path);
  for (const [name, child] of Object.entries((schemaNode['properties'] ?? {}) as Record<string, unknown>)) {
    walkSchemas(child, visit, `${path}/properties/${name}`);
  }
  if ('items' in schemaNode) walkSchemas(schemaNode['items'], visit, `${path}/items`);
  ((schemaNode['anyOf'] ?? []) as unknown[]).forEach((branch, index) => walkSchemas(branch, visit, `${path}/anyOf/${index}`));
}

describe('schema.json', () => {
  it('is up to date (run `npm run schema`)', () => {
    expect(readFileSync(new URL('schema.json', root), 'utf8')).toBe(renderPolicyJsonSchema());
  });

  it('is published with the package at the URL init writes into $schema', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('schema.json');
    expect(schema['$id']).toBe(SCHEMA_URL);
    expect(DEFAULT_POLICY.$schema).toBe(SCHEMA_URL);
  });

  it('uses draft-07 and forbids unknown fields in every object', () => {
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    walkSchemas(schema, (node, path) => {
      if (node['type'] === 'object') expect(node['additionalProperties'], path).toBe(false);
    });
  });

  it('describes every field, so editors can show help on hover', () => {
    walkSchemas(schema, (node, path) => {
      if (path.includes('/properties/')) expect(typeof node['description'], path).toBe('string');
    });
  });
});

describe('schema.json agrees with the validator', () => {
  it.each(policyFixtureNames())('on fixture %s', (name) => {
    const document: unknown = JSON.parse(readFixture(name, 'depcurfew.json') ?? '');
    const valid = parsePolicy(readFixture(name, 'depcurfew.json') ?? '').ok;
    expect(matchesSchema(schema, document)).toBe(valid || VALIDATOR_ONLY.has(name));
    if (VALIDATOR_ONLY.has(name)) expect(valid).toBe(false);
  });

  it('on the default policy', () => {
    expect(matchesSchema(schema, DEFAULT_POLICY)).toBe(true);
    expect(validatePolicy(DEFAULT_POLICY).ok).toBe(true);
  });

  const durationSchema = (schema['properties'] as Record<string, Record<string, unknown>>)['cooldown']?.['properties'] as Record<
    string,
    Record<string, unknown>
  >;

  it.each([
    '1m', '36h', '3d', '1w', '2160h', '0d', '00d', '03d', '1.5d', '3D', '3 days', ' 3d', '3days', '1d12h', '36', '', 'abc', '-3d', '1M', '3s',
  ])('on duration %j', (text) => {
    expect(matchesSchema(durationSchema['minimum'] ?? {}, text)).toBe(parseDuration(text).ok);
  });

  const excludeItems = (durationSchema['exclude']?.['items'] ?? {}) as Record<string, unknown>;

  it.each([
    'esbuild', '@playwright/test', '@moja-firma/*', '@acme/**', 'eslint-plugin-*', 'lodash.get', '~tilde', 'JSONStream', '@*/*',
    '', '*', '**', 'foo bar', 'esbuild@0.25.0', '@scope/pkg@1', './local', '.hidden', '_private', '@scope', '@/name', 'a/b', 'https://x',
  ])('on package pattern %j', (pattern) => {
    expect(matchesSchema(excludeItems, pattern)).toBe(validatePackagePattern(pattern) === undefined);
  });

  const projectItems = ((schema['properties'] as Record<string, Record<string, unknown>>)['projects']?.['items'] ?? {}) as Record<string, unknown>;

  it.each([
    'frontend', 'services/api', '.config', 'a.b/c-d_e', 'web app', 'x/.y', '..a', 'a..', 'deck',
    '', '.', './', '..', '../x', 'a/../b', 'a/./b', './a', '/a', 'a/', 'a//b', 'C:/a', 'c:a', 'a\\b', '\\\\server\\x', 'packages/*', 'a?b', 'a:b',
    'node_modules', 'x/node_modules/y', '.git', 'a/.git', 'tab\there', 'a|b',
  ])('on project directory %j', (entry) => {
    expect(matchesSchema(projectItems, entry)).toBe(validateProjectDirectory(entry) === undefined);
  });
});
