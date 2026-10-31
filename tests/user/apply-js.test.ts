// apply --user for pnpm (rc in pnpm 10, config.yaml from 11), Yarn (~/.yarnrc.yml) and Bun (.bunfig.toml), with the
// version given with --for where it cannot be read from files. The home directory and PATH are temporary.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validatePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function policy(document: unknown): ResolvedPolicy {
  const result = validatePolicy(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const POLICY = policy({
  version: 1,
  cooldown: { minimum: '3d', exclude: ['@acme/*'] },
  installScripts: { default: 'deny', allow: ['esbuild'] },
  sources: { git: 'deny', remoteTarball: 'deny' },
  targets: ['pnpm', 'yarn', 'bun'],
});

function machine(env: Record<string, string> = {}): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-js-'));
  temporary.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { platform: 'linux', home, env: { PATH: join(root, 'bin'), ...env } };
}

const after = (planned: ReturnType<typeof planUserApply>, file: string) => planned.report.changes.find((change) => change.file === file)?.after;
const codes = (planned: ReturnType<typeof planUserApply>) => planned.report.warningDetails.map((warning) => `${warning.tool ?? ''}:${warning.code}`);

describe('apply --user for pnpm, Yarn and Bun', () => {
  it('writes nothing for tools whose version is unknown and whose bad values stop every command', () => {
    const planned = planUserApply(POLICY, { environment: machine() });
    expect(planned.report.changes).toEqual([]);
    expect(codes(planned)).toEqual(expect.arrayContaining(['pnpm:version-unknown', 'yarn:version-unknown', 'bun:version-unknown']));
  });

  it('writes ~/.config/pnpm/config.yaml for pnpm 11, with allowBuilds left to the projects', () => {
    const environment = machine();
    const planned = planUserApply(POLICY, { environment, versions: { pnpm: [11, 28, 10] } });
    const text = after(planned, '~/.config/pnpm/config.yaml') ?? '';
    expect(text).toContain('minimumReleaseAge: 4320');
    expect(text).toContain('minimumReleaseAgeExclude:');
    expect(text).toContain('minimumReleaseAgeStrict: true');
    expect(text).toContain('strictDepBuilds: true');
    expect(text).toContain('blockExoticSubdeps: true');
    expect(codes(planned)).toContain('pnpm:user-setting-project-only');
    writeUserChanges(planned);
    expect(planUserApply(POLICY, { environment, versions: { pnpm: [11, 28, 10] } }).report.changes).toEqual([]);
  });

  it('leaves blockExoticSubdeps out for pnpm 12, which ignores it in config.yaml, and follows XDG_CONFIG_HOME', () => {
    const environment = machine();
    const xdg = join(environment.home, 'xdg');
    const planned = planUserApply(POLICY, { environment: { ...environment, env: { ...environment.env, XDG_CONFIG_HOME: xdg } }, versions: { pnpm: [12, 17, 0] } });
    const change = planned.report.changes[0];
    expect(change?.path).toBe(join(xdg, 'pnpm', 'config.yaml'));
    expect(change?.after).not.toContain('blockExoticSubdeps');
  });

  it('writes <configDir>/rc in INI for pnpm 10, with the allow-list there', () => {
    const planned = planUserApply(POLICY, { environment: machine(), versions: { pnpm: [10, 34, 9] } });
    const text = after(planned, '~/.config/pnpm/rc') ?? '';
    expect(text).toContain('minimum-release-age=4320\n');
    expect(text).toContain('minimum-release-age-exclude[]=@acme/*\n');
    expect(text).toContain('only-built-dependencies[]=esbuild\n');
    expect(text).toContain('block-exotic-subdeps=true\n');
  });

  it('writes ~/.yarnrc.yml for Yarn with the same keys as a project file, and dependenciesMeta is left to the projects', () => {
    const environment = machine();
    writeFileSync(join(environment.home, '.yarnrc.yml'), 'npmRegistryServer: "https://registry.example.com"\n');
    const planned = planUserApply(POLICY, { environment, versions: { yarn: [4, 18, 1] } });
    const text = after(planned, '~/.yarnrc.yml') ?? '';
    expect(text).toContain('npmRegistryServer: "https://registry.example.com"');
    expect(text).toContain('npmMinimalAgeGate:');
    expect(text).toContain('enableScripts: false');
    expect(text).toContain('approvedGitRepositories: []');
    expect(codes(planned)).toContain('yarn:user-setting-project-only');
  });

  it('writes [install] of ~/.bunfig.toml in seconds for Bun, and reports exceptions it cannot take', () => {
    const planned = planUserApply(POLICY, { environment: machine(), versions: { bun: [1, 4, 4] } });
    const text = after(planned, '~/.bunfig.toml') ?? '';
    expect(text).toContain('[install]\n');
    expect(text).toContain('minimumReleaseAge = 259200\n');
    // Bun takes exact package names only, so the @acme/* pattern is reported instead of written.
    expect(text).not.toContain('minimumReleaseAgeExcludes');
    expect(codes(planned)).toEqual(expect.arrayContaining(['bun:exclude-pattern-unsupported', 'bun:user-setting-project-only']));
  });
});
