// doctor's SARIF output validates against the official OASIS schema, for every fixture, and meets the extra
// requirements of GitHub code scanning (rule descriptions, help, a full region for every result).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES, runDoctor, toSarif, type DoctorReport } from '../../src/doctor/index.ts';
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
  return toSarif(runDoctor(directory, { invalidPolicy: 'report' }), RULES, '0.0.0', readLine) as Record<string, unknown>;
}

describe('SARIF output', () => {
  it('uses the unchanged official schema', () => {
    expect(createHash('sha256').update(readFileSync(SCHEMA_FILE)).digest('hex')).toBe('c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e');
  });

  it('the validator rejects an invalid log', () => {
    expect(validator.validate({ version: '2.1.0', runs: [{ tool: { driver: {} } }] })).toContain('$.runs[0].tool.driver: missing required property "name"');
    expect(validator.validate({ version: '2.1.0', runs: [{ tool: { driver: { name: 'x' } }, results: [{ message: { text: 'm' }, level: 'fatal' }] }] }).length).toBeGreaterThan(0);
  });

  it.each(repositories.map((directory) => [directory.split(sep).join('/').replace(/^.*?(?=fixtures\/)/u, ''), directory]))('%s is valid SARIF', (_name, directory) => {
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

  it('percent-encodes each segment of a path as a URI reference and keeps the slashes', () => {
    const file = 'sub dir/zażółć 100%\n#?:x.json';
    const report: DoctorReport = { schemaVersion: 1, policy: 'valid', findings: [{ rule: 'config-drift', level: 'error', location: { file, line: 1 }, message: 'm' }], notices: [{ level: 'note', code: 'unreadable-file', message: 'n', file, location: { file } }] };
    const sarif = toSarif(report, RULES, '0.0.0') as { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[]; invocations: { toolExecutionNotifications: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] }[] };
    const uri = 'sub%20dir/za%C5%BC%C3%B3%C5%82%C4%87%20100%25%0A%23%3F%3Ax.json';
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(uri);
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(uri);
    expect(decodeURIComponent(uri)).toBe(file);
    expect(validator.validate(sarif)).toEqual([]);
  });

  it('marks a run that could not check anything as not successful, with the error as a notification', () => {
    const report: DoctorReport = { schemaVersion: 1, policy: 'missing', findings: [], notices: [] };
    const sarif = toSarif(report, RULES, '0.0.0', undefined, [{ code: 'directory-not-found', message: 'directory not found: x', fix: 'Pass the path of an existing directory' }]) as { runs: { invocations: unknown[] }[] };
    expect(sarif.runs[0]?.invocations).toEqual([
      { executionSuccessful: false, toolExecutionNotifications: [{ level: 'error', message: { text: 'directory not found: x. Fix: Pass the path of an existing directory' }, descriptor: { id: 'directory-not-found' } }] },
    ]);
    expect(validator.validate(sarif)).toEqual([]);
  });
});
