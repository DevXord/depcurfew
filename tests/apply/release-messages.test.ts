// Messages of apply after the release review of 1.0.0 (decision D-082): every warning says what to do, and the
// text reads cleanly.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-release-messages-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const warning = (root: string, code: string) => applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === code);

describe('apply messages', () => {
  it('does not leave the colon of a YAML error excerpt before its own text', () => {
    const root = repo({
      'package.json': '{"name": "x", "packageManager": "pnpm@10.20.0"}\n',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "a"\nonlyBuiltDependencies:\n  - "esbuild\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n',
    });
    expect(warning(root, 'file-unreadable')).toEqual({
      code: 'file-unreadable',
      location: { file: 'pnpm-workspace.yaml' },
      message: 'cannot parse pnpm-workspace.yaml: Missing closing "quote at line 5, column 1; depcurfew cannot tell which tools it configures',
      fix: 'Fix the syntax error in pnpm-workspace.yaml, then run depcurfew apply again',
    });
  });

  it('says what to do when Dependabot cannot delay security updates', () => {
    const root = repo({
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d", "securityUpdates": "delay"}, "targets": ["dependabot"]}\n',
    });
    expect(warning(root, 'security-delay-unsupported')?.fix).toBe(
      'Review Dependabot security pull requests before merging them, or set cooldown.securityUpdates to "bypass" in depcurfew.json, which is what Dependabot does',
    );
  });

  it('says what to do when one pnpm setting covers git and tarball sources', () => {
    const root = repo({
      'package.json': '{"name": "x", "packageManager": "pnpm@10.26.0"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'depcurfew.json': '{"version": 1, "sources": {"git": "deny", "remoteTarball": "allow"}}\n',
    });
    expect(warning(root, 'source-switch-combined')?.fix).toBe(
      'pnpm cannot deny one and allow the other: give sources.git and sources.remoteTarball the same value in depcurfew.json, so that the policy says what pnpm does',
    );
  });

  it('points pip users at the requirements files, as pip has no lockfile of its own', () => {
    const root = repo({
      'requirements.txt': 'requests==2.32.3\n',
      'depcurfew.json': '{"version": 1, "installScripts": {"default": "deny"}, "sources": {"git": "deny"}}\n',
    });
    expect(warning(root, 'build-switch-scope')?.fix).toBe('Run depcurfew doctor to find them in the requirements files');
    expect(warning(root, 'source-not-enforceable')?.fix).toBe('Run depcurfew doctor, which reports such dependencies in the requirements files');
  });
});
