// `depcurfew apply` through the CLI: output, --dry-run, policy errors, files that cannot be edited and the bots'
// delay never being shorter than the one a package manager enforces.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { botDuration } from '../../src/apply/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { parseDuration } from '../../src/policy/duration.ts';
import { canSymlink } from '../support/platform.ts';

const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../fixtures/expected/', import.meta.url));
const POLICY = readFileSync(new URL('../fixtures/apply/policy.json', import.meta.url), 'utf8');

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(fixture?: string, policy: string | null = POLICY): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-apply-cli-'));
  temporary.push(directory);
  if (fixture !== undefined) cpSync(join(REPOS, fixture), directory, { recursive: true });
  if (policy !== null) writeFileSync(join(directory, 'depcurfew.json'), policy);
  return directory;
}

function write(directory: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
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

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .filter((file) => statSync(join(directory, file)).isFile())
      .map((file) => [file, readFileSync(join(directory, file), 'utf8')]),
  );
}

/** Applies a unified diff to the files of `directory` in memory, checking every context and removed line. */
function applyPatch(directory: string, patch: string): Record<string, string> {
  const result: Record<string, string> = {};
  const sections = patch.split(/^(?=--- )/mu).filter((section) => section !== '');
  for (const section of sections) {
    const lines = section.split('\n');
    const file = (lines[1] ?? '').replace(/^\+\+\+ b\//u, '');
    const old = lines[0] === '--- /dev/null' ? [] : readFileSync(join(directory, file), 'utf8').split('\n');
    const output: string[] = [];
    let position = 0;
    for (let index = 2; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/u.exec(line);
      if (header !== null) {
        const start = Number(header[1]) - (header[2] === '0' ? 0 : 1);
        output.push(...old.slice(position, start));
        position = start;
      } else if (line.startsWith(' ') || line.startsWith('-')) {
        expect(old[position], `${file}: line ${position + 1}`).toBe(line.slice(1));
        if (line.startsWith(' ')) output.push(line.slice(1));
        position += 1;
      } else if (line.startsWith('+')) {
        output.push(line.slice(1));
      }
    }
    output.push(...old.slice(position));
    result[file] = output.join('\n');
  }
  return result;
}

describe('depcurfew apply', () => {
  it('writes the changes and reports them; a second run changes nothing', async () => {
    const directory = scratch('package-json-only');
    const first = await exec('apply', directory);
    expect(first.code).toBe(EXIT_OK);
    expect(first.stdout).toBe('Created .npmrc\nUpdated package.json\n');
    expect(first.stderr).toBe(
      [
        'warning: npm: no exact version is pinned, so depcurfew configures for npm 12.2.1, the latest version it knows (version-not-pinned)',
        '  fix: Pin the version you use (packageManager, devEngines, .tool-versions or a CI setup step) to configure for it',
        'warning: npm: allowScripts takes package names only; "@scope/*" not written (allow-pattern-unsupported)',
        '  fix: List the package names in installScripts.allow',
        '',
      ].join('\n'),
    );
    for (const file of ['.npmrc', 'package.json']) {
      expect(readFileSync(join(directory, file), 'utf8')).toBe(readFileSync(join(EXPECTED, 'package-json-only/after', file), 'utf8'));
    }

    const second = await exec('apply', directory);
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toBe('No files changed; what depcurfew could not apply is listed below.\n');
  });

  it('--dry-run prints a diff that produces the expected files and writes nothing', async () => {
    const directory = scratch('npm-existing-config');
    const before = snapshot(directory);
    const result = await exec('apply', '--dry-run', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(snapshot(directory)).toEqual(before);
    expect(result.stdout).toMatch(/^--- a\/\.npmrc\n\+\+\+ b\/\.npmrc\n@@ /u);
    expect(result.stderr.endsWith('Dry run: 2 files would change; nothing written.\n')).toBe(true);

    const patched = applyPatch(directory, result.stdout);
    expect(Object.keys(patched).sort()).toEqual(['.npmrc', 'package.json']);
    for (const [file, text] of Object.entries(patched)) {
      expect(text, file).toBe(readFileSync(join(EXPECTED, 'npm-existing-config/after', file), 'utf8'));
    }
  });

  it('--dry-run shows new files against /dev/null', async () => {
    const directory = scratch('bun-lockb');
    const result = await exec('apply', directory, '--dry-run');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('--- /dev/null\n+++ b/bunfig.toml\n@@ -0,0 +1,5 @@\n+[install]\n');
    expect(existsSync(join(directory, 'bunfig.toml'))).toBe(false);
  });

  it('marks a last line without a line break like diff -u', async () => {
    const directory = scratch('npm-basic');
    writeFileSync(join(directory, 'package.json'), '{\n  "name": "x"\n}');
    const result = await exec('apply', '--dry-run', directory);
    expect(result.stdout).toContain('+    "esbuild": true\n+  }\n }\n\\ No newline at end of file\n');
  });

  it('warns about allow-list entries it does not remove', async () => {
    const result = await exec('apply', scratch('npm-existing-config'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain(
      'warning: allowScripts in package.json (line 6) lets sharp run install scripts, but depcurfew.json does not allow it; depcurfew apply does not remove entries it did not write (allow-list-entry-outside-policy)\n  fix: Remove sharp from allowScripts by hand, or add sharp to installScripts.allow in depcurfew.json\n',
    );
  });

  it('says the configuration matches only when nothing was left out', async () => {
    const policy = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['sharp'] } });
    const directory = scratch('npm-existing-config', policy);
    expect((await exec('apply', directory)).stderr).toBe('');
    const second = await exec('apply', directory);
    expect(second).toEqual({ code: EXIT_OK, stdout: 'Nothing to change; the configuration already matches the policy.\n', stderr: '' });
  });

  it('prints snippets for files it does not edit', async () => {
    const directory = scratch('volta-renovate');
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe('No files changed; what depcurfew could not apply is listed below.\n');
    expect(result.stderr).toContain('Renovate: add this to .github/renovate.json5 by hand:\n  {\n    "minimumReleaseAge": "3 days",\n');
  });

  it('fails without a policy file', async () => {
    const directory = scratch('npm-basic', null);
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`error: no depcurfew.json in ${directory} (policy-missing)\n  fix: Run 'depcurfew init' first\n`);
  });

  it('fails with an invalid policy file and lists the problems', async () => {
    const directory = scratch('npm-basic', '{ "version": 1, "cooldown": { "minimum": "soon" } }');
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^error: depcurfew\.json is invalid \(policy-invalid\)\n {2}\S.*\n {2}fix: Fix these problems in depcurfew\.json/u);
    expect(snapshot(directory)['.npmrc']).toBe('save-exact=true\n');
  });

  it('fails for a directory that does not exist', async () => {
    const result = await exec('apply', join(tmpdir(), 'depcurfew-does-not-exist'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('directory not found');
  });

  it('writes nothing when a file cannot be edited', async () => {
    const directory = scratch('npm-basic');
    write(directory, { 'package.json': '{ "name": "broken", ' });
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^error: npm: cannot edit package\.json: .* \(cannot-edit\)\n {2}fix: Fix what the message describes, then run depcurfew apply again; or add the settings by hand$/mu);
    expect(result.stderr.endsWith('depcurfew: nothing written because of the errors above.\n')).toBe(true);
    expect(snapshot(directory)['.npmrc']).toBe('save-exact=true\n');
  });

  it('--dry-run prints no diff when a file cannot be edited', async () => {
    const directory = scratch('package-json-only');
    write(directory, { 'renovate.json': '{ "extends": [ }\n' });
    const result = await exec('apply', '--dry-run', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: Renovate: cannot edit renovate.json');
    expect(result.stderr).toContain('depcurfew: apply would write nothing because of the errors above.\n');
  });

  it.skipIf(!canSymlink())('does not write through a symlink', async () => {
    const directory = scratch('package-json-only');
    const outside = scratch(undefined, null);
    write(outside, { '.npmrc': 'registry=https://registry.npmjs.org/\n' });
    symlinkSync(join(outside, '.npmrc'), join(directory, '.npmrc'));
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('error: npm: cannot edit .npmrc: .npmrc is a symlink; depcurfew does not write through symlinks (cannot-edit)\n');
    expect(readFileSync(join(outside, '.npmrc'), 'utf8')).toBe('registry=https://registry.npmjs.org/\n');
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(readFileSync(join(REPOS, 'package-json-only/package.json'), 'utf8'));
  });
});

describe('depcurfew apply --json', () => {
  const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown> & { changes: { file: string; action: string; diff: string }[]; warnings: unknown[]; errors: Record<string, unknown>[] };

  it('prints the result as JSON, with a code for every warning, and nothing on stderr', async () => {
    const directory = scratch('package-json-only');
    const result = await exec('apply', '--json', directory);
    expect([result.code, result.stderr]).toEqual([EXIT_OK, '']);
    const report = parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, policy: 'valid', dryRun: false, written: true, snippets: [], errors: [], summary: { changes: 2, warnings: 2, errors: 0 } });
    expect(report.changes.map((change) => [change.file, change.action])).toEqual([
      ['.npmrc', 'create'],
      ['package.json', 'update'],
    ]);
    expect(report.changes[0]?.diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/\.npmrc\n@@ /u);
    expect(report.warnings).toEqual([
      {
        code: 'version-not-pinned',
        level: 'warning',
        tool: 'npm',
        message: 'npm: no exact version is pinned, so depcurfew configures for npm 12.2.1, the latest version it knows',
        fix: 'Pin the version you use (packageManager, devEngines, .tool-versions or a CI setup step) to configure for it',
      },
      { code: 'allow-pattern-unsupported', level: 'warning', tool: 'npm', message: 'npm: allowScripts takes package names only; "@scope/*" not written', fix: 'List the package names in installScripts.allow' },
    ]);
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toBe(readFileSync(join(EXPECTED, 'package-json-only/after/.npmrc'), 'utf8'));
  });

  it('with --dry-run writes nothing, and the diffs produce the expected files', async () => {
    const directory = scratch('npm-existing-config');
    const before = snapshot(directory);
    const result = await exec('apply', '--dry-run', '--json', directory);
    expect([result.code, result.stderr]).toEqual([EXIT_OK, '']);
    expect(snapshot(directory)).toEqual(before);
    const report = parse(result.stdout);
    expect(report).toMatchObject({ dryRun: true, written: false });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'allow-list-entry-outside-policy', tool: 'npm', location: { file: 'package.json', line: 6 } }));
    const patched = applyPatch(directory, report.changes.map((change) => change.diff).join(''));
    for (const [file, text] of Object.entries(patched)) {
      expect(text, file).toBe(readFileSync(join(EXPECTED, 'npm-existing-config/after', file), 'utf8'));
    }
  });

  it('reports a file it cannot edit as an error, lists no changes and writes nothing', async () => {
    const directory = scratch('npm-basic');
    write(directory, { 'package.json': '{ "name": "broken", ' });
    const result = await exec('apply', '--json', directory);
    expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
    const report = parse(result.stdout);
    expect(report).toMatchObject({ written: false, changes: [], summary: { changes: 0, errors: 1 } });
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'cannot-edit', level: 'error', tool: 'npm', location: { file: 'package.json', line: 1 }, fix: 'Fix what the message describes, then run depcurfew apply again; or add the settings by hand' }),
    ]);
    expect(String(report.errors[0]?.['message'])).toMatch(/^npm: cannot edit package\.json: /u);
    expect(snapshot(directory)['.npmrc']).toBe('save-exact=true\n');
  });

  it('does not edit a TOML file that does not parse', async () => {
    const directory = scratch(undefined, JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
    write(directory, { 'pyproject.toml': '[project\nname = "app"\n', 'uv.lock': 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n' });
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = parse(result.stdout);
    expect(report).toMatchObject({ written: false, changes: [] });
    expect(report.errors).toEqual([expect.objectContaining({ code: 'cannot-edit', tool: 'uv', location: { file: 'pyproject.toml', line: 1 } })]);
    expect(String(report.errors[0]?.['message'])).toContain('uv: cannot edit pyproject.toml: invalid TOML at line 1');
    expect(readFileSync(join(directory, 'pyproject.toml'), 'utf8')).toBe('[project\nname = "app"\n');
  });

  it('reports a missing or invalid policy as JSON', async () => {
    const missing = scratch('npm-basic', null);
    const none = await exec('apply', '--json', missing);
    expect([none.code, none.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(parse(none.stdout)).toMatchObject({
      schemaVersion: 1,
      policy: 'missing',
      written: false,
      changes: [],
      errors: [{ code: 'policy-missing', level: 'error', location: { file: 'depcurfew.json' }, message: `no depcurfew.json in ${missing}`, fix: "Run 'depcurfew init' first" }],
    });
    const invalid = await exec('apply', '--json', scratch('npm-basic', '{ "version": 1, "cooldown": { "minimum": "soon" } }'));
    expect(invalid.code).toBe(EXIT_FAILURE);
    const error = parse(invalid.stdout).errors[0];
    expect(error).toMatchObject({
      code: 'policy-invalid',
      level: 'error',
      location: { file: 'depcurfew.json' },
      message: 'depcurfew.json is invalid',
      fix: 'Fix these problems in depcurfew.json; an editor that reads its $schema shows them as you type',
    });
    expect((error?.['issues'] as string[]).length).toBeGreaterThan(0);
  });
});

describe('the bots wait at least as long as the package managers', () => {
  it('botDuration keeps the policy when no manager rounded up', () => {
    const policy = parseDuration('3d');
    if (!policy.ok) throw new Error('bad duration');
    expect(botDuration(policy.duration, [4320, 4320])).toBe(policy.duration);
    expect(botDuration(policy.duration, [])).toBe(policy.duration);
  });

  it('botDuration takes the longest delay a manager wrote', () => {
    const policy = parseDuration('36h');
    if (!policy.ok) throw new Error('bad duration');
    expect(botDuration(policy.duration, [2160, 2880])).toEqual({ text: '2d', minutes: 2880 });
  });

  it('a delay npm rounds up to whole days reaches Renovate and Dependabot', async () => {
    const policy = JSON.parse(POLICY) as Record<string, unknown>;
    policy['cooldown'] = { minimum: '36h', exclude: [], securityUpdates: 'bypass' };
    const directory = scratch(undefined, JSON.stringify(policy));
    write(directory, {
      'package.json': '{ "name": "x", "packageManager": "npm@12.2.1" }\n',
      'package-lock.json': '{ "lockfileVersion": 3 }\n',
      'renovate.json': '{}\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n',
    });
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toContain('min-release-age=2\n');
    expect(JSON.parse(readFileSync(join(directory, 'renovate.json'), 'utf8'))).toMatchObject({ minimumReleaseAge: '2 days' });
    expect(readFileSync(join(directory, '.github/dependabot.yml'), 'utf8')).toContain('default-days: 2\n');
  });
});
