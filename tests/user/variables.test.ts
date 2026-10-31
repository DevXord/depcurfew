// Environment variables that override the user files (doctor --user, decision D-087): every spelling that is set,
// the name as it is set, the default user file that npm passes to the commands it runs, versions and boolean values.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Version } from '../../src/apply/version.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { environmentOverrides } from '../../src/user/variables.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function environment(env: Record<string, string>, npmrc?: string): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-variables-'));
  temporary.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  if (npmrc !== undefined) writeFileSync(join(home, '.npmrc'), npmrc);
  return { platform, home, env };
}

const tools = (...ids: ToolId[]) => knowledgeBase.filter((tool) => ids.includes(tool.id));
const found = (env: UserEnvironment, ids: ToolId[], versions?: Partial<Record<ToolId, Version>>) =>
  environmentOverrides(env, tools(...ids), versions).map((override) => `${override.tool}:${override.name}=${override.value}`);

describe('environmentOverrides', () => {
  it('checks every spelling that is set and not empty, and names the variable as it is set', () => {
    expect(found(environment({ npm_config_userconfig: '', NPM_CONFIG_USERCONFIG: '/x/npmrc' }), ['npm'])).toEqual(['npm:NPM_CONFIG_USERCONFIG=/x/npmrc']);
    expect(found(environment({ npm_config_dangerously_allow_all_scripts: 'false', NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true' }), ['npm'])).toEqual([
      'npm:NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS=true',
    ]);
    expect(found(environment({ NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true', npm_config_dangerously_allow_all_scripts: 'false' }), ['npm'])).toEqual([
      'npm:NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS=true',
    ]);
  });

  it('does not count the default user file that npm passes to the commands it runs', () => {
    const env = environment({});
    expect(found({ ...env, env: { npm_config_userconfig: join(env.home, '.npmrc') } }, ['npm', 'pnpm'])).toEqual([]);
    expect(found({ ...env, env: { npm_config_userconfig: '~/.npmrc' } }, ['npm'])).toEqual([]);
    expect(found({ ...env, env: { npm_config_userconfig: join(env.home, 'other-npmrc') } }, ['npm'])).toEqual([`npm:npm_config_userconfig=${join(env.home, 'other-npmrc')}`]);
  });

  it('does not count, under npm, a value that npm passes on from ~/.npmrc', () => {
    const underNpm = { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' };
    expect(found(environment({ ...underNpm, npm_config_before: '2026-01-01' }, 'before=2026-01-01\n'), ['npm'])).toEqual([]);
    expect(found(environment({ ...underNpm, npm_config_minimum_release_age: '4320' }, 'minimum-release-age=4320\n'), ['pnpm'], { pnpm: [10, 28, 0] })).toEqual([]);
    expect(found(environment({ ...underNpm, npm_config_before: '2026-01-01' }, 'save-exact=true\n'), ['npm'])).toEqual(['npm:npm_config_before=2026-01-01']);
    expect(found(environment({ npm_config_before: '2026-01-01' }, 'before=2026-01-01\n'), ['npm'])).toEqual(['npm:npm_config_before=2026-01-01']);
  });

  it('respects the versions that read a variable', () => {
    const pnpmVariable = environment({ pnpm_config_minimum_release_age: '0' });
    expect(found(pnpmVariable, ['pnpm'], { pnpm: [10, 34, 9] })).toEqual([]);
    expect(found(pnpmVariable, ['pnpm'], { pnpm: [11, 28, 10] })).toEqual(['pnpm:pnpm_config_minimum_release_age=0']);
    expect(found(pnpmVariable, ['pnpm'])).toEqual(['pnpm:pnpm_config_minimum_release_age=0']);
    const npmVariable = environment({ npm_config_minimum_release_age: '0' });
    expect(found(npmVariable, ['pnpm'], { pnpm: [11, 28, 10] })).toEqual([]);
    expect(found(npmVariable, ['pnpm'], { pnpm: [10, 34, 9] })).toEqual(['pnpm:npm_config_minimum_release_age=0']);
  });

  it('takes the boolean values of uv as uv parses them: a false value changes nothing', () => {
    for (const value of ['0', 'false', 'off', 'no', 'N']) {
      expect(found(environment({ UV_NO_BUILD: value, UV_NO_CONFIG: value, UV_NO_BINARY: value }), ['uv'])).toEqual([]);
    }
    expect(found(environment({ UV_NO_BUILD: 'TRUE' }), ['uv'])).toEqual(['uv:UV_NO_BUILD=TRUE']);
    expect(found(environment({ UV_NO_CONFIG: '1' }), ['uv'])).toEqual(['uv:UV_NO_CONFIG=1']);
  });
});
