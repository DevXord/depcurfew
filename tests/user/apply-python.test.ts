// apply --user for uv, pip, Poetry, PDM and Pipenv: the user file of each, the version read from its .dist-info, and
// nothing written for uv or pip when their version is unknown (a value they cannot parse stops every command).
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
  cooldown: { minimum: '3d', exclude: ['pypi:internal-tools'] },
  installScripts: { default: 'deny', allow: ['pypi:psycopg2'] },
  targets: 'auto',
});

/** Python tools installed in a virtual environment whose bin folder is in PATH (name → version). */
function machine(installed: Record<string, string>): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-python-'));
  temporary.push(root);
  const home = join(root, 'home');
  const venv = join(root, 'venv');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(venv, 'bin'), { recursive: true });
  for (const [name, version] of Object.entries(installed)) {
    const info = join(venv, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`);
    writeFileSync(join(info, 'entry_points.txt'), `[console_scripts]\n${name} = ${name}.__main__:main\n`);
    writeFileSync(join(venv, 'bin', name), '#!/usr/bin/python3\n');
  }
  return { platform: 'linux', home, env: { PATH: join(venv, 'bin') } };
}

const after = (planned: ReturnType<typeof planUserApply>, file: string) => planned.report.changes.find((change) => change.file === file)?.after;
const codes = (planned: ReturnType<typeof planUserApply>) => planned.report.warningDetails.map((warning) => `${warning.tool ?? ''}:${warning.code}`);

describe('apply --user for Python tools', () => {
  it('writes ~/.config/uv/uv.toml for the installed uv, and the second run changes nothing', () => {
    const environment = machine({ uv: '0.13.6' });
    const planned = planUserApply(POLICY, { environment });
    expect(after(planned, '~/.config/uv/uv.toml')).toBe(
      [
        '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead',
        'exclude-newer = "3 days"',
        'exclude-newer-package = { "internal-tools" = false }',
        'no-build = true',
        'no-binary-package = ["psycopg2"]',
        '# <<< depcurfew managed block',
        '',
      ].join('\n'),
    );
    writeUserChanges(planned);
    expect(planUserApply(POLICY, { environment }).report.changes).toEqual([]);
  });

  it('writes nothing for uv and pip when their version cannot be read, and says how to give it', () => {
    const environment = machine({});
    const bin = environment.env['PATH'] ?? '';
    writeFileSync(join(bin, 'uv'), 'binary');
    writeFileSync(join(bin, 'pip'), '#!/bin/sh\n');
    const planned = planUserApply(POLICY, { environment });
    expect(planned.report.changes).toEqual([]);
    expect(codes(planned)).toEqual(expect.arrayContaining(['uv:version-unknown', 'pip:version-unknown']));
    expect(planned.report.warningDetails.find((warning) => warning.tool === 'uv')?.fix).toBe(
      'Pass the version with --for uv@<version> (uv --version shows it), then run depcurfew apply --user again',
    );
    const given = planUserApply(POLICY, { environment, versions: { uv: [0, 13, 6], pip: [26, 2, 2] } });
    expect(given.report.changes.map((change) => change.file).sort()).toEqual(['~/.config/pip/pip.conf', '~/.config/uv/uv.toml']);
  });

  it('writes [global] of pip.conf with uploaded-prior-to as a duration, keeping the rest of the file', () => {
    const environment = machine({ pip: '26.2.2' });
    mkdirSync(join(environment.home, '.config', 'pip'), { recursive: true });
    writeFileSync(join(environment.home, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://pypi.org/simple\n\n[install]\nuser = true\n');
    const planned = planUserApply(POLICY, { environment });
    expect(after(planned, '~/.config/pip/pip.conf')).toBe(
      [
        '[global]',
        '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead',
        'uploaded-prior-to = P3D',
        'only-binary = :all:',
        'no-binary = psycopg2',
        '# <<< depcurfew managed block',
        'index-url = https://pypi.org/simple',
        '',
        '[install]',
        'user = true',
        '',
      ].join('\n'),
    );
    writeUserChanges(planned);
    expect(planUserApply(POLICY, { environment }).report.changes).toEqual([]);
  });

  it('does not write uploaded-prior-to for pip 26.0, which accepts only dates there', () => {
    const planned = planUserApply(POLICY, { environment: machine({ pip: '26.0.1' }) });
    expect(after(planned, '~/.config/pip/pip.conf')).not.toContain('uploaded-prior-to');
    expect(codes(planned)).toContain('pip:version-too-old');
  });

  it('writes Poetry and PDM config.toml, and nothing for Pipenv, which has no user file', () => {
    const environment = machine({ poetry: '2.5.1', pdm: '2.29.5', pipenv: '2026.10.4' });
    const planned = planUserApply(POLICY, { environment });
    expect(after(planned, '~/.config/pypoetry/config.toml')).toContain('[solver]\n# >>> depcurfew managed block [solver]: edit depcurfew.json and run depcurfew apply instead\nmin-release-age = 3\n');
    expect(after(planned, '~/.config/pypoetry/config.toml')).toContain('[installer]\n# >>> depcurfew managed block [installer]: edit depcurfew.json and run depcurfew apply instead\nonly-binary = [":all:"]\nno-binary = ["psycopg2"]\n');
    expect(after(planned, '~/.config/pdm/config.toml')).toContain('exclude-newer = "3d"');
    expect(codes(planned)).toEqual(expect.arrayContaining(['pipenv:no-user-config', 'pdm:user-setting-project-only']));
  });
});
