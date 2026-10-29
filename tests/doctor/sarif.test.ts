// doctor's SARIF output validates against the official OASIS schema, for every fixture, and meets the extra
// requirements of GitHub code scanning (rule descriptions, help, a full region for every result).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES, runDoctor, toSarif } from '../../src/doctor/index.ts';
import { JsonSchemaValidator } from '../support/json-schema.ts';

const SCHEMA_FILE = new URL('../fixtures/sarif/sarif-schema-2.1.0.json', import.meta.url);
const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));

const schemaText = readFileSync(SCHEMA_FILE, 'utf8');
const validator = new JsonSchemaValidator(JSON.parse(schemaText) as Record<string, unknown>);

function subdirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

const repositories = [
  ...subdirectories(DOCTOR).flatMap((rule) => subdirectories(join(DOCTOR, rule)).map((name) => join(DOCTOR, rule, name, 'repo'))),
  ...subdirectories(REPOS).map((name) => join(REPOS, name)),
];

function sarifFor(directory: string): Record<string, unknown> {
  const readLine = (file: string, line: number) => {
    try {
      return readFileSync(join(directory, file), 'utf8').split(/\r?\n/u)[line - 1];
    } catch {
      return undefined;
    }
  };
  return toSarif(runDoctor(directory), RULES, '0.0.0', readLine) as Record<string, unknown>;
}

describe('SARIF output', () => {
  it('uses the unchanged official schema', () => {
    expect(createHash('sha256').update(readFileSync(SCHEMA_FILE)).digest('hex')).toBe('c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e');
  });

  it('the validator rejects an invalid log', () => {
    expect(validator.validate({ version: '2.1.0', runs: [{ tool: { driver: {} } }] })).toContain('$.runs[0].tool.driver: missing required property "name"');
    expect(validator.validate({ version: '2.1.0', runs: [{ tool: { driver: { name: 'x' } }, results: [{ message: { text: 'm' }, level: 'fatal' }] }] }).length).toBeGreaterThan(0);
  });

  it.each(repositories.map((directory) => [directory.slice(directory.indexOf('fixtures/')), directory]))('%s is valid SARIF', (_name, directory) => {
    expect(validator.validate(sarifFor(directory))).toEqual([]);
  });

  it('meets the GitHub code scanning requirements', () => {
    const sarif = sarifFor(join(DOCTOR, 'broad-exclusion/fires-tools/repo')) as {
      $schema: string;
      runs: {
        tool: { driver: { name: string; rules: { id: string; shortDescription: { text: string }; fullDescription: { text: string }; help: { text: string }; name: string }[] } };
        results: { message: { text: string }; locations: { physicalLocation: { artifactLocation: { uri: string }; region: Record<string, number> } }[] }[];
      }[];
    };
    expect(sarif.$schema).toMatch(/^https:\/\//u);
    const run = sarif.runs[0];
    expect(run?.tool.driver.name).toBe('depcurfew');
    for (const rule of run?.tool.driver.rules ?? []) {
      expect(rule.shortDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.fullDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.help.text).not.toBe('');
      expect(rule.name.length).toBeLessThanOrEqual(255);
    }
    expect(run?.results.length).toBeGreaterThan(0);
    for (const result of run?.results ?? []) {
      expect(result.message.text).not.toBe('');
      const [location] = result.locations;
      expect(location?.physicalLocation.artifactLocation.uri).not.toMatch(/^(\/|[a-z]+:)/u);
      const region = location?.physicalLocation.region ?? {};
      expect(Object.keys(region).sort()).toEqual(['endColumn', 'endLine', 'startColumn', 'startLine']);
      expect(region['endColumn']).toBeGreaterThan(region['startColumn'] ?? 0);
    }
  });
});
