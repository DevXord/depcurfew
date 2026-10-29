// Generators after the review before 1.0.0: what apply writes is what doctor then accepts (decision P8).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('Dependabot semver-*-days', () => {
  it('raises the ones below the policy, keeps longer ones and adds none', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-dependabot-'));
    temporary.push(root);
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, 'package.json'), '{"name": "app", "packageManager": "npm@11.19.1"}\n');
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    writeFileSync(
      join(root, '.github/dependabot.yml'),
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 1\n      semver-patch-days: 1\n      semver-major-days: 30\n',
    );
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    const written = parseYaml(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')) as { updates: { cooldown: Record<string, number> }[] };
    expect(written.updates[0]?.cooldown).toEqual({ 'default-days': 3, 'semver-patch-days': 3, 'semver-major-days': 30 });
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });
});
