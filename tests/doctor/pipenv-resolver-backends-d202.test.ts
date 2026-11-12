// Pipenv's resolver backends that lock without cool-down-period (decision D-202): the uv backend of Pipenv 2026.11.0
// and pure-python, in resolver_backend or in the older key resolver of the Pipfile, compared stripped as Pipenv reads
// them, the older key also next to resolver_backend, and PIPENV_RESOLVER and PIPENV_BACKEND for doctor --user. The
// fixtures are in tests/fixtures/doctor/python-config-ignored; the CLI runs in this process.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { environmentOverrides } from '../../src/user/variables.ts';
import { platform } from '../support/user.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/doctor/python-config-ignored/', import.meta.url));

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

interface JsonFinding {
  rule: string;
  level: string;
  location: { file: string; line?: number };
  message: string;
  fix: string;
}

async function doctorJson(name: string): Promise<{ code: number; findings: JsonFinding[] }> {
  let stdout = '';
  const code = await run(['doctor', join(FIXTURES, name, 'repo'), '--json'], { stdout: (text) => (stdout += text), stderr: () => undefined });
  const report = JSON.parse(stdout) as { findings: JsonFinding[] };
  return { code, findings: report.findings.filter((finding) => finding.rule === 'python-config-ignored') };
}

describe('doctor: Pipenv resolver backends without cool-down-period', () => {
  it.each([
    ['fires-pipenv-uv-backend', [10]],
    ['fires-pipenv-legacy-resolver', [11]],
    ['fires-pipenv-padded-value', [10]],
    ['fires-pipenv-both-keys', [12]],
    ['fires-pipenv-pure-python-resolver', [10]],
  ])('%s exits 1 with the line in Pipfile and a fix naming resolver_backend = "pip"', async (name, lines) => {
    const { code, findings } = await doctorJson(name);
    expect(code).toBe(EXIT_FAILURE);
    expect(findings.map((finding) => [finding.level, finding.location.file, finding.location.line])).toEqual(lines.map((line) => ['error', 'Pipfile', line]));
    for (const finding of findings) {
      expect(finding.fix).toContain('resolver_backend = "pip"');
      expect(`${finding.message} ${finding.fix}`).not.toMatch(/uv\.toml|UV_EXCLUDE_NEWER/u);
    }
  });

  it('passes resolver_backend = "pip"', async () => {
    const { code, findings } = await doctorJson('passes-pipenv-pip-backend');
    expect(findings).toEqual([]);
    expect(code).toBe(EXIT_OK);
  });
});

function machine(env: Record<string, string>): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-pipenv-backends-'));
  temporary.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // Pipenv in PATH, without a version: every variable of the knowledge base counts.
  writeFileSync(join(bin, 'pipenv'), '#!/bin/sh\n');
  return { platform, home, env: { PATH: bin, ...env } };
}

const pipenv = knowledgeBase.filter((tool) => tool.id === 'pipenv');
const overrides = (env: Record<string, string>) => environmentOverrides(machine(env), pipenv).map((override) => `${override.name}=${override.value}`);

describe('doctor --user: PIPENV_RESOLVER and PIPENV_BACKEND', () => {
  it('reports PIPENV_RESOLVER=uv with what it does', () => {
    const report = runUserDoctor({ environment: machine({ PIPENV_RESOLVER: 'uv' }) });
    const found = report.findings.filter((finding) => finding.rule === 'user-environment-overrides');
    expect(found).toEqual([
      {
        rule: 'user-environment-overrides',
        level: 'warning',
        location: { file: 'environment', variable: 'PIPENV_RESOLVER' },
        message: 'PIPENV_RESOLVER=uv is set in the environment (Pipenv): selects a resolver backend that does not apply cool-down-period',
        fix: 'Unset PIPENV_RESOLVER in your shell profile or CI settings, or set it to a value the policy allows',
      },
    ]);
  });

  it('reports PIPENV_BACKEND, which pipenv lock reads as --backend', () => {
    const report = runUserDoctor({ environment: machine({ PIPENV_BACKEND: 'uv' }) });
    expect(report.findings.filter((finding) => finding.rule === 'user-environment-overrides').map((finding) => finding.message)).toEqual([
      'PIPENV_BACKEND=uv is set in the environment (Pipenv): selects the resolver backend of pipenv lock, one that does not apply cool-down-period',
    ]);
  });

  it('counts the backends that skip cool-down-period, stripped as Pipenv reads them, and not pip', () => {
    expect(overrides({ PIPENV_RESOLVER: 'pure-python' })).toEqual(['PIPENV_RESOLVER=pure-python']);
    expect(overrides({ PIPENV_RESOLVER: ' uv ' })).toEqual(['PIPENV_RESOLVER= uv ']);
    expect(overrides({ PIPENV_BACKEND: 'pure-python' })).toEqual(['PIPENV_BACKEND=pure-python']);
    expect(overrides({ PIPENV_RESOLVER: 'pip', PIPENV_BACKEND: 'pip' })).toEqual([]);
  });
});
