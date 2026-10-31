// depcurfew apply --user (decision D-087): the user policy in each installed tool's user file, written like apply
// writes project files (managed block, comments kept, a second run changes nothing). The home directory and PATH are
// temporary directories, so the tests never touch the real user files.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validatePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { canSymlink } from '../support/platform.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function policy(document: unknown): ResolvedPolicy {
  const result = validatePolicy(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const DEFAULT = {
  version: 1,
  cooldown: { minimum: '3d' },
  installScripts: { default: 'deny', allow: ['esbuild'] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
};

/** A home directory and a PATH with the given npm-installed tools (name → version). */
function machine(installed: Record<string, string> = {}): UserEnvironment & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-'));
  temporary.push(root);
  const home = join(root, 'home');
  const prefix = join(root, 'prefix');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  for (const [name, version] of Object.entries(installed)) {
    const pkg = join(prefix, 'lib', 'node_modules', name);
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version, bin: { [name]: `bin/${name}.js` } }));
    writeFileSync(join(pkg, 'bin', `${name}.js`), '');
    if (canSymlink()) symlinkSync(join(pkg, 'bin', `${name}.js`), join(prefix, 'bin', name));
    else writeFileSync(join(prefix, 'bin', name), '');
  }
  return { root, platform, home, env: { PATH: join(prefix, 'bin') } };
}

describe('apply --user for npm and Deno (~/.npmrc)', () => {
  it.skipIf(!canSymlink())('writes the policy into ~/.npmrc for the installed npm, keeps the rest of the file, and changes nothing the second time', () => {
    const environment = machine({ npm: '11.21.1' });
    writeFileSync(join(environment.home, '.npmrc'), '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nsave-exact=true\n');
    const planned = planUserApply(policy(DEFAULT), { environment });
    expect(planned.report.errors).toEqual([]);
    expect(planned.report.changes.map((change) => change.file)).toEqual(['~/.npmrc']);
    writeUserChanges(planned);
    expect(readFileSync(join(environment.home, '.npmrc'), 'utf8')).toBe(
      [
        '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
        'save-exact=true',
        '',
        '# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead',
        'min-release-age=3',
        'strict-allow-scripts=true',
        'allow-scripts=esbuild',
        'allow-git=none',
        'allow-remote=none',
        'allow-file=all',
        'allow-directory=all',
        '# <<< depcurfew managed block',
        '',
      ].join('\n'),
    );
    expect(planUserApply(policy(DEFAULT), { environment }).report.changes).toEqual([]);
  });

  it('configures for the latest npm it knows, with a warning, when the version cannot be read; --for wins', () => {
    const environment = machine();
    writeFileSync(join(environment.env['PATH'] ?? '', 'npm'), '#!/bin/sh\n');
    const unknown = planUserApply(policy(DEFAULT), { environment });
    expect(unknown.report.warningDetails.map((warning) => warning.code)).toContain('version-not-pinned');
    // npm 12 blocks dependency scripts by default, so strict-allow-scripts is not needed.
    expect(unknown.report.changes[0]?.after).not.toContain('strict-allow-scripts');
    const given = planUserApply(policy(DEFAULT), { environment, versions: { npm: [11, 6, 0] } });
    expect(given.report.warningDetails.map((warning) => warning.code)).toContain('version-too-old');
    expect(given.report.changes).toEqual([]);
  });

  it.skipIf(!canSymlink())('writes only min-release-age in whole days for Deno, in the same block when npm is configured too', () => {
    const environment = machine({ npm: '11.21.1', deno: '2.9.8' });
    const both = planUserApply(policy({ ...DEFAULT, cooldown: { minimum: '36h' } }), { environment });
    const text = both.report.changes[0]?.after ?? '';
    expect(text.match(/min-release-age=/gu)).toHaveLength(1);
    // npm takes days with fractions rounded up as well: 36 hours is 2 days.
    expect(text).toContain('min-release-age=2\n');
    const alone = planUserApply(policy({ ...DEFAULT, cooldown: { minimum: '36h' }, targets: ['deno'] }), { environment });
    expect(alone.report.changes[0]?.after).toBe(
      ['# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead', 'min-release-age=2', '# <<< depcurfew managed block', ''].join('\n'),
    );
    expect(alone.report.warningDetails.map((warning) => warning.code)).toContain('user-setting-project-only');
  });

  it('configures nothing when no tool is in PATH and the policy lists none', () => {
    const environment = machine();
    const planned = planUserApply(policy(DEFAULT), { environment });
    expect(planned.report.changes).toEqual([]);
    expect(planned.report.warningDetails.map((warning) => warning.code)).toEqual(['nothing-to-configure']);
  });
});
