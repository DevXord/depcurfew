// CodeQL analyzes the code and the workflows of the repository with the narrowest permissions, builds nothing and
// leaves out the sample repositories and the generated action bundle (decision D-176).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

const workflow = parse(readFileSync(new URL('../../.github/workflows/codeql.yml', import.meta.url), 'utf8')) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { permissions: Record<string, string>; 'timeout-minutes'?: number; strategy: { 'fail-fast': boolean; matrix: { language: string[] } }; steps: Step[] }>;
};
const job = workflow.jobs['analyze'];
const step = (name: string) => job?.steps.find((candidate) => candidate.uses?.startsWith(`${name}@`));

describe('CodeQL workflow', () => {
  it('runs on pull requests and pushes to main, every week and on demand', () => {
    expect(workflow.on).toMatchObject({ push: { branches: ['main'] }, pull_request: { branches: ['main'] }, workflow_dispatch: null });
    expect(workflow.on['schedule']).toHaveLength(1);
  });

  it('has only contents: read and security-events: write, and a time limit', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['analyze']);
    expect(job?.permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    expect(job?.['timeout-minutes']).toBeGreaterThan(0);
  });

  it('analyzes TypeScript and the workflows from the source, one language per job', () => {
    expect(job?.strategy).toEqual({ 'fail-fast': false, matrix: { language: ['javascript-typescript', 'actions'] } });
    expect(step('github/codeql-action/init')?.with).toMatchObject({ languages: '${{ matrix.language }}', 'build-mode': 'none' });
    expect(step('github/codeql-action/analyze')?.with).toEqual({ category: '/language:${{ matrix.language }}' });
    expect(job?.steps.some((candidate) => candidate.run !== undefined)).toBe(false);
  });

  it('leaves out the fixtures and the action bundle, and keeps no credentials in the checkout', () => {
    const config = parse(String(step('github/codeql-action/init')?.with?.['config'])) as { 'paths-ignore': string[] };
    expect(config).toEqual({ 'paths-ignore': ['tests/fixtures', 'action/depcurfew.mjs'] });
    expect(step('actions/checkout')?.with).toEqual({ 'persist-credentials': false });
  });
});
