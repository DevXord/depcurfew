// `depgate apply` through the CLI: output, --dry-run, policy errors, files that cannot be edited and the bots'
// delay never being shorter than the one a package manager enforces.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { botDuration } from '../../src/apply/index.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { parseDuration } from '../../src/policy/duration.ts';

const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../fixtures/expected/', import.meta.url));
const POLICY = readFileSync(new URL('../fixtures/apply/policy.json', import.meta.url), 'utf8');

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(fixture?: string, policy: string | null = POLICY): string {
  const directory = mkdtempSync(join(tmpdir(), 'depgate-apply-cli-'));
  temporary.push(directory);
  if (fixture !== undefined) cpSync(join(REPOS, fixture), directory, { recursive: true });
  if (policy !== null) writeFileSync(join(directory, 'depgate.json'), policy);
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

describe('depgate apply', () => {
  it('writes the changes and reports them; a second run changes nothing', async () => {
    const directory = scratch('package-json-only');
    const first = await exec('apply', directory);
    expect(first.code).toBe(EXIT_OK);
    expect(first.stdout).toBe('Created .npmrc\nUpdated package.json\n');
    expect(first.stderr).toBe(
      [
        'warning: npm: no exact version is pinned; configuring for npm 12.2.1, the latest known version',
        'warning: npm: allowScripts takes package names only; "@scope/*" not written',
        '',
      ].join('\n'),
    );
    for (const file of ['.npmrc', 'package.json']) {
      expect(readFileSync(join(directory, file), 'utf8')).toBe(readFileSync(join(EXPECTED, 'package-json-only/after', file), 'utf8'));
    }

    const second = await exec('apply', directory);
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toBe('Nothing to change; the configuration already matches the policy.\n');
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

  it('prints snippets for files it does not edit', async () => {
    const directory = scratch('volta-renovate');
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe('Nothing to change; the configuration already matches the policy.\n');
    expect(result.stderr).toContain('Renovate: add this to .github/renovate.json5 by hand:\n  {\n    "minimumReleaseAge": "3 days",\n');
  });

  it('fails without a policy file', async () => {
    const directory = scratch('npm-basic', null);
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`depgate: no depgate.json in ${directory}; run 'depgate init' first\n`);
  });

  it('fails with an invalid policy file and lists the problems', async () => {
    const directory = scratch('npm-basic', '{ "version": 1, "cooldown": { "minimum": "soon" } }');
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^depgate: depgate\.json is invalid\n {2}\S/u);
    expect(snapshot(directory)['.npmrc']).toBe('save-exact=true\n');
  });

  it('fails for a directory that does not exist', async () => {
    const result = await exec('apply', join(tmpdir(), 'depgate-does-not-exist'));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('directory not found');
  });

  it('writes nothing when a file cannot be edited', async () => {
    const directory = scratch('npm-basic');
    write(directory, { 'package.json': '{ "name": "broken", ' });
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^error: npm: cannot edit package\.json: /mu);
    expect(result.stderr.endsWith('depgate: nothing written because of the errors above.\n')).toBe(true);
    expect(snapshot(directory)['.npmrc']).toBe('save-exact=true\n');
  });

  it('does not write through a symlink', async () => {
    const directory = scratch('package-json-only');
    const outside = scratch(undefined, null);
    write(outside, { '.npmrc': 'registry=https://registry.npmjs.org/\n' });
    symlinkSync(join(outside, '.npmrc'), join(directory, '.npmrc'));
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('error: npm: cannot edit .npmrc: .npmrc is a symlink; depgate does not write through symlinks\n');
    expect(readFileSync(join(outside, '.npmrc'), 'utf8')).toBe('registry=https://registry.npmjs.org/\n');
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(readFileSync(join(REPOS, 'package-json-only/package.json'), 'utf8'));
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
