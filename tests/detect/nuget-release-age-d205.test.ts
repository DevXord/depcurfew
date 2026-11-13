// NuGet after .NET 11 (decision D-205): minPublishAgeHours in nuget.config is a verified fact from .NET SDK 11.0.100
// (NuGet 8.0.0) on, and depcurfew says exactly what it covers: only the versions dotnet package add and dotnet package
// update choose themselves, not what a restore takes, and the 10.0 SDKs and earlier do not read it. The commands come from
// the knowledge base (selectedBy); the old updatesOnly field stays readable for library callers until a minor release.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { botEcosystemFact, botEcosystemFacts, ownDelayText } from '../../src/detect/bot-ecosystems.ts';
import { detectProject } from '../../src/detect/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { environment } from '../../src/knowledge/environment.ts';
import type { ClientDelayKnowledge, EnvironmentKnowledge } from '../../src/knowledge/types.ts';

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-nuget-d205-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

const NUGET_DETAILS =
  'NuGet has no release-age delay for what a restore takes (minPublishAgeHours in nuget.config holds back only the versions that dotnet package add and dotnet package update choose when no version is given; .NET SDK 11.0.100 reads it, the 10.0 SDKs and earlier ignore it, and depcurfew does not configure it)';
const NUGET_SHORT =
  'NuGet has no release-age delay for what a restore takes (minPublishAgeHours holds back only the versions that dotnet package add and dotnet package update choose, from .NET SDK 11.0.100 on)';

describe('the NuGet release-age fact', () => {
  const fact = environment.botOnlyEcosystems.nuget.releaseAge;

  it('is verified, from a pinned official source, with the commands that apply it', () => {
    expect(fact.status).toBe('verified');
    if (fact.status !== 'verified') return;
    expect(fact.verifiedAt).toBe('2026-11-11');
    expect(fact.source).toMatch(/^https:\/\/github\.com\/NuGet\/docs\.microsoft\.com-nuget\/blob\/[0-9a-f]{40}\/docs\/consume-packages\/minimum-package-publish-age\.md$/);
    expect(fact.value).toEqual({ setting: 'minPublishAgeHours', since: '11.0.100', product: '.NET SDK', selectedBy: ['dotnet package add', 'dotnet package update'], ignoredBy: 'the 10.0 SDKs and earlier', file: 'nuget.config' });
    expect(fact.value).not.toHaveProperty('updatesOnly');
  });

  it('names the release, the NuGet version and the open issues in its note, and no longer calls it planned', () => {
    const note = fact.note ?? '';
    for (const text of ['ff6107d71eb826353b4e577cfd0c88fe703aa5b5', 'v11.0.100', 'f1c3fba23859095e1b9261e935c8c7b1e1642a85', '8.0.0', 'v10.0.404', 'NU1020', 'v11.0.100-rc.3.26522.148', '684427012e25096073d04a7643a9d43dc1f2091d']) expect(note).toContain(text);
    for (const issue of ['15029', '15030', '15033', '15034']) expect(note).toContain(`NuGet/Home/issues/${issue}`);
    expect(note).not.toContain('Uncertain');
    expect(note).not.toContain('not released');
    // A published note describes the sources, not the session that read them.
    expect(note).not.toContain('this session');
    expect(note).toContain('learn.microsoft.com itself was not checked');
  });
});

describe('what depcurfew says NuGet does about new versions', () => {
  const nuget = botEcosystemFact('nuget');

  it('names the commands that filter, the first SDK that reads the attribute, and that restore does not wait', () => {
    expect(nuget).toBeDefined();
    if (nuget === undefined) return;
    expect(ownDelayText(nuget, true)).toBe(NUGET_DETAILS);
    expect(ownDelayText(nuget, false)).toBe(NUGET_SHORT);
  });

  // Cargo left the ecosystems updated by bots only in 1.7.0 (E08).
  it('keeps the texts of Go modules, Maven and Gradle as they were', () => {
    const texts = Object.fromEntries(botEcosystemFacts().flatMap((entry) => (entry.id === 'nuget' ? [] : [[entry.id, [ownDelayText(entry, true), ownDelayText(entry, false)]]])));
    expect(texts).toEqual({
      gomod: ['Go has no release-age delay of its own', 'Go has no release-age delay of its own'],
      maven: ['Maven has no release-age delay of its own', 'Maven has no release-age delay of its own'],
      gradle: ['Gradle has no release-age delay of its own', 'Gradle has no release-age delay of its own'],
    });
  });

  it('still reads the deprecated updatesOnly of a knowledge object passed to detectProject', () => {
    const legacy: ClientDelayKnowledge = { setting: 'minPublishAgeHours', since: '11.0.100', product: '.NET SDK', updatesOnly: true, file: 'nuget.config' };
    const old: EnvironmentKnowledge = {
      ...environment,
      botOnlyEcosystems: {
        ...environment.botOnlyEcosystems,
        nuget: { ...environment.botOnlyEcosystems.nuget, releaseAge: { status: 'verified', value: legacy, source: 'https://example.invalid/nuget', verifiedAt: '2026-11-03' } },
      },
    };
    const root = repository({ 'App.csproj': '<Project/>' });
    expect(detectProject(root, undefined, old).botEcosystems).toEqual([{ id: 'nuget', files: ['App.csproj'] }]);
    const entry = botEcosystemFact('nuget', old);
    expect(entry?.delay).toEqual(legacy);
    if (entry === undefined) return;
    expect(ownDelayText(entry, true)).toBe(
      'NuGet has no release-age delay for what an install or restore takes (minPublishAgeHours in nuget.config, from .NET SDK 11.0.100 on, holds back only the versions an update picks, and depcurfew does not configure it)',
    );
    // selectedBy wins over updatesOnly when an object has both.
    const both = { ...entry, delay: { ...legacy, selectedBy: ['dotnet package add', 'dotnet package update'], ignoredBy: 'the 10.0 SDKs and earlier' } };
    expect(ownDelayText(both, true)).toBe(NUGET_DETAILS);
    // Without ignoredBy, the text names only the version that reads the setting and claims nothing about earlier ones.
    const unnamed = { ...entry, delay: { ...legacy, selectedBy: ['dotnet package add', 'dotnet package update'] } };
    expect(ownDelayText(unnamed, true)).toBe(
      'NuGet has no release-age delay for what a restore takes (minPublishAgeHours in nuget.config holds back only the versions that dotnet package add and dotnet package update choose when no version is given; .NET SDK 11.0.100 reads it, and depcurfew does not configure it)',
    );
  });

  it('gives the note for a NuGet project without a bot with the new text', () => {
    const root = repository({ 'App.csproj': '<Project/>' });
    const findings = runDoctor(root).findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch');
    expect(findings.map((finding) => finding.message)).toEqual([
      `No update bot delays new versions of NuGet dependencies: the repository configures neither Dependabot nor Renovate, and ${NUGET_DETAILS}, so no bot and no setting depcurfew configures holds back the versions the dependencies in App.csproj are updated to`,
    ]);
  });
});

describe('README', () => {
  it('shows the NuGet row as verified, with the commands that filter', () => {
    const row = README.split('\n').find((line) => line.startsWith('| NuGet (bots only) |'));
    expect(row).toBe(
      '| NuGet (bots only) | `minPublishAgeHours` in `nuget.config`, since .NET SDK 11.0.100, only for the versions `dotnet package add` and `dotnet package update` choose (depcurfew does not write it); the delay comes from the bots: Dependabot `nuget`, Renovate `nuget` | n/a | n/a | n/a | 2026-11-03 – 2026-11-11 |',
    );
  });

  it('says in Update bots what minPublishAgeHours does not cover', () => {
    const section = README.slice(README.indexOf('### Update bots'), README.indexOf('### Composer projects'));
    const bullet = section.split('\n').find((line) => line.startsWith("- **What NuGet's"));
    expect(bullet).toBeDefined();
    for (const text of [
      '`minPublishAgeHours`',
      '`dotnet package add`',
      '`dotnet package update`',
      'explicit version',
      'transitive',
      '`NU1020`',
      'Package Manager Console',
      '`dotnet package list`',
      '`dotnet tool`',
      '`dnx`',
      '`dotnet new install`',
      'not documented',
      '`depcurfew mcp`',
      'the 10.0 SDKs and earlier ignore it',
      'so depcurfew delays NuGet dependencies only through the bots',
    ])
      expect(bullet).toContain(text);
    // Prerelease SDKs of 11.0 already read the attribute, and with it set the commands above make dependencies wait too.
    expect(bullet).not.toContain('earlier SDKs ignore it');
    expect(bullet).not.toContain('wait only through the bots');
  });
});
