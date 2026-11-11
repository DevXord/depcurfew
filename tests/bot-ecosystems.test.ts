// Ecosystems updated by bots only (decision D-151): Cargo, Go modules, Maven, Gradle and NuGet are detected by their
// files, explain says that only the bots wait for them, doctor compares the bots' delay for them with cooldown.minimum
// and notes them in a repository without a bot, and apply gives their Dependabot entries the cooldown.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from '../src/detect/index.ts';
import { botEcosystemFacts, ownDelayText } from '../src/detect/bot-ecosystems.ts';
import { botEcosystemTargets, readRenovateConfig, renovateDelay } from '../src/doctor/renovate.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { longestDelay } from '../src/apply/delays.ts';
import { renovate } from '../src/knowledge/renovate.ts';
import { EXIT_OK, run } from '../src/cli/run.ts';

const repo = (name: string) => fileURLToPath(new URL(`fixtures/repos/${name}`, import.meta.url));

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A repository in a temporary directory with the files given, removed after the test. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-bot-ecosystems-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const CARGO_LINE =
  'Cargo before 1.100.0 has no release-age delay of its own (Cargo 1.100.0 adds registry.global-min-publish-age in .cargo/config.toml, which depcurfew does not configure), so only the update bots wait before they propose new versions (Dependabot package-ecosystem: cargo, Renovate manager cargo)';

describe('detection', () => {
  it('finds the files in the root, its direct subdirectories that are not hidden, workspace packages and projects', () => {
    const root = repository({
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'packages/native/package.json': JSON.stringify({ name: 'native', version: '1.0.0' }),
      'packages/native/Cargo.toml': '[package]\nname = "native"\n',
      'services/api/pom.xml': '<project/>',
      'services/other/pom.xml': '<project/>',
      'app/App.csproj': '<Project/>',
      'app/App.csproj.user': '<Project/>',
      'app/.csproj': '<Project/>',
      '.config/go.mod': 'module hidden\n',
      'deep/er/go.mod': 'module deep\n',
    });
    const detection = detectProject(root, undefined, undefined, { projects: ['services/api'] });
    expect(detection.botEcosystems).toEqual([
      { id: 'cargo', files: ['packages/native/Cargo.toml'] },
      { id: 'maven', files: ['services/api/pom.xml'] },
      { id: 'nuget', files: ['app/App.csproj'] },
    ]);
  });

  it('gives no nothing-detected warning for a repository of one of these ecosystems, and no field without one', () => {
    expect(detectProject(repository({ 'go.mod': 'module example.com/tool\n' })).warnings).toEqual([]);
    const empty = detectProject(repository({ 'README.md': 'nothing here\n' }));
    expect(empty.warnings.map((warning) => warning.code)).toEqual(['nothing-detected']);
    expect('botEcosystems' in empty).toBe(false);
  });

  it('says what each package manager does about new versions', () => {
    const texts = Object.fromEntries(botEcosystemFacts().map((entry) => [entry.id, ownDelayText(entry, true)]));
    expect(texts).toEqual({
      cargo: 'Cargo before 1.100.0 has no release-age delay of its own (Cargo 1.100.0 adds registry.global-min-publish-age in .cargo/config.toml, which depcurfew does not configure)',
      gomod: 'Go has no release-age delay of its own',
      maven: 'Maven has no release-age delay of its own',
      gradle: 'Gradle has no release-age delay of its own',
      nuget: 'NuGet has no release-age delay for what a restore takes (minPublishAgeHours in nuget.config holds back only the versions that dotnet package add and dotnet package update choose when no version is given; .NET SDK 11.0.100 is the first to read it, earlier ones ignore it, and depcurfew does not configure it)',
    });
  });
});

describe('depcurfew explain', () => {
  it('lists the ecosystems updated by bots only and says that only the bots wait', async () => {
    const result = await exec('explain', repo('cargo-dependabot'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(['Bots:', '  Dependabot: .github/dependabot.yml', 'Updated by bots only:', '  Cargo: Cargo.lock, Cargo.toml', `    ${CARGO_LINE}`, 'Workspaces: none'].join('\n'));
  });

  it('gives the same in JSON, with the name and the sentence', async () => {
    const result = await exec('explain', '--json', repo('cargo-dependabot'));
    const report = JSON.parse(result.stdout) as { project: { botEcosystems: unknown } };
    expect(report.project.botEcosystems).toEqual([{ id: 'cargo', name: 'Cargo', files: ['Cargo.lock', 'Cargo.toml'], message: CARGO_LINE }]);
  });

  it('shows no such section without these ecosystems', async () => {
    const result = await exec('explain', repo('npm-basic'));
    expect(result.stdout).not.toContain('Updated by bots only');
    expect(JSON.parse((await exec('explain', '--json', repo('npm-basic'))).stdout).project).not.toHaveProperty('botEcosystems');
  });
});

describe('Renovate', () => {
  it('knows the manager, datasource and categories of each ecosystem', () => {
    expect(botEcosystemTargets(renovate, ['cargo', 'gomod', 'maven', 'gradle', 'nuget'])).toEqual([
      { datasource: 'crate', manager: 'cargo', categories: ['rust'], ecosystem: 'cargo' },
      { datasource: 'go', manager: 'gomod', categories: ['golang'], ecosystem: 'gomod' },
      { datasource: 'maven', manager: 'maven', categories: ['java'], ecosystem: 'maven' },
      { datasource: 'maven', manager: 'gradle', categories: ['java'], ecosystem: 'gradle' },
      { datasource: 'nuget', manager: 'nuget', categories: ['dotnet'], ecosystem: 'nuget' },
    ]);
  });

  it('reads security:minimumReleaseAgeCrate as 3 days for Cargo dependencies only', () => {
    const config = readRenovateConfig(JSON.stringify({ extends: ['security:minimumReleaseAgeCrate'] }), 'renovate.json', []);
    const [cargo, gomod] = botEcosystemTargets(renovate, ['cargo', 'gomod']);
    const cargoDelay = cargo === undefined ? undefined : renovateDelay(renovate, config, cargo);
    const gomodDelay = gomod === undefined ? undefined : renovateDelay(renovate, config, gomod);
    expect(cargoDelay?.known === true ? cargoDelay.byType.get('major')?.value : undefined).toBe('3 days');
    expect(gomodDelay?.known === true ? gomodDelay.byType.size : undefined).toBe(0);
  });
});

describe('doctor', () => {
  it('says to run depcurfew apply when depcurfew.json has a cooldown, and gives no note with a bot', () => {
    const root = repository({ 'pom.xml': '<project/>', 'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }) });
    const notes = runDoctor(root).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch');
    expect(notes.map((finding) => [finding.level, finding.location, finding.fix])).toEqual([
      [
        'note',
        { file: 'pom.xml' },
        'Update these dependencies with Dependabot (an updates entry with package-ecosystem: maven in .github/dependabot.yml) or Renovate (its maven manager), then run depcurfew apply, which gives the bot the cooldown of depcurfew.json; depcurfew delays Maven dependencies only through these bots',
      ],
    ]);
    const withBot = repository({ 'pom.xml': '<project/>', 'renovate.json': '{ "minimumReleaseAge": "3 days" }' });
    expect(runDoctor(withBot).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
  });
});

describe('init', () => {
  it('keeps a longer default-days of an entry of these ecosystems in cooldown.minimum', () => {
    const root = repository({
      'go.mod': 'module example.com/tool\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: "gomod"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n    cooldown:\n      default-days: 10\n',
    });
    const delay = longestDelay(root, detectProject(root), 3 * 1440);
    expect(delay).toMatchObject({ tool: 'dependabot', label: 'gomod updates', setting: 'default-days', value: 10, location: { file: '.github/dependabot.yml', line: 8 } });
  });
});
