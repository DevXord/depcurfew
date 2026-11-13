// The bots and Cargo's own delay (E08, the second part of E32). From 1.7.0 depcurfew apply writes Cargo's delay into
// .cargo/config.toml, so Cargo is a package manager like the others and no longer an ecosystem updated by bots only:
// explain lists it once, the Dependabot entries of cargo and the Renovate manager cargo (crate datasource) count as the
// bots of a package manager, a repository without a bot gets no note for Cargo, and the lists of the ecosystems updated
// by bots only come from the knowledge base (environment.botOnlyEcosystems).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPolicyIfPresent } from '../src/apply/index.ts';
import { detectProject } from '../src/detect/index.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { managerTargets } from '../src/doctor/renovate.ts';
import { cargo } from '../src/knowledge/cargo.ts';
import { environment } from '../src/knowledge/environment.ts';
import { renovate } from '../src/knowledge/renovate.ts';
import { describeBotOnlyEcosystems } from '../src/knowledge/render.ts';

const repo = (name: string) => fileURLToPath(new URL(`fixtures/repos/${name}`, import.meta.url));

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e08-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function exec(...argv: string[]): Promise<string> {
  let stdout = '';
  await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} });
  return stdout;
}

const CARGO = { 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n', 'Cargo.lock': 'version = 4\n' };
const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'allow' }, sources: { git: 'allow', remoteTarball: 'allow', file: 'allow', directory: 'allow' }, targets: 'auto' });
const BLOCK = '[registry]\n# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nglobal-min-publish-age = "3 days"\n# <<< depcurfew managed block\n';
const dependabot = (days: number) =>
  `version: 2\nupdates:\n  - package-ecosystem: "cargo"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n    cooldown:\n      default-days: ${days}\n`;

describe('Cargo is a package manager, not an ecosystem updated by bots only (E08)', () => {
  it('is no longer among the ecosystems updated by bots only', () => {
    expect(Object.keys(environment.botOnlyEcosystems)).toEqual(['gomod', 'maven', 'gradle', 'nuget']);
    expect(detectProject(repo('cargo-dependabot')).botEcosystems).toBeUndefined();
  });

  it('is listed once by explain, without "Updated by bots only"', async () => {
    const text = await exec('explain', repo('cargo-dependabot'));
    expect(text).toContain('Package managers:\n  Cargo\n');
    expect(text).not.toContain('Updated by bots only');
    expect(text).not.toContain('does not configure');
    const json = JSON.parse(await exec('explain', '--json', repo('cargo-dependabot'))) as { project: { botEcosystems?: unknown } };
    expect(json.project.botEcosystems).toBeUndefined();
  });

  it('gives a Renovate target of its own to Cargo: the cargo manager, the crate datasource, the rust category', () => {
    expect(managerTargets(renovate, [cargo]).map((group) => group.target)).toEqual([{ datasource: 'crate', manager: 'cargo', categories: ['rust'] }]);
  });

  it('compares the cooldown of a Dependabot cargo entry with cooldown.minimum, as for the other package managers', () => {
    const root = repository({ ...CARGO, 'depcurfew.json': POLICY, '.cargo/config.toml': BLOCK, '.github/dependabot.yml': dependabot(1) });
    const found = runDoctor(root, { policy: loadPolicyIfPresent(root) ?? null }).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch');
    expect(found.map((finding) => [finding.level, finding.location?.file])).toEqual([['error', '.github/dependabot.yml']]);
    expect(found[0]?.message).not.toContain('only through');
    const longer = repository({ ...CARGO, 'depcurfew.json': POLICY, '.cargo/config.toml': BLOCK, '.github/dependabot.yml': dependabot(3) });
    expect(runDoctor(longer, { policy: loadPolicyIfPresent(longer) ?? null }).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });

  it('gives no note to a Cargo repository without a bot: Cargo delays new versions itself', () => {
    const root = repository({ ...CARGO, 'depcurfew.json': POLICY, '.cargo/config.toml': BLOCK });
    expect(runDoctor(root, { policy: loadPolicyIfPresent(root) ?? null }).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });

  it('names the ecosystems updated by bots only from the knowledge base', () => {
    expect(describeBotOnlyEcosystems(environment)).toBe('Go modules, Maven, Gradle and NuGet');
  });
});
