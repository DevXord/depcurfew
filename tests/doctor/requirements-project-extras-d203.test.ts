// Decision D-203: "-e .[cli]" in a requirements file is the project itself, as "-e ." is. pip takes one trailing group of
// extras off a path before it looks at the path (strip_extras, src/pip/_internal/utils/urls.py at 26.3), and its
// documentation installs the project in the current directory as '.[PDF]'. Until 1.6.0 depcurfew read ".[cli]" as an
// unnamed local directory, so right after depcurfew init and depcurfew apply, doctor failed on the most common layout of
// a Python library (lockfile-install-scripts, and lockfile-forbidden-source under sources.directory "deny"). ".[]",
// "..[x]" and "./sub[x]" stay local directories.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { requirementsEntries, requirementsFormatOf } from '../../src/doctor/python-lockfiles.ts';
import { pip } from '../../src/knowledge/pip.ts';

const SOURCE = fileURLToPath(new URL('../fixtures/python-project-extras/repo/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const read = (text: string) => requirementsEntries(text, requirementsFormatOf(pip)).map((entry) => [entry.name, entry.source, entry.line]);

describe('the project itself with extras in a requirements file (decision D-203)', () => {
  it('is the project in every form pip reads as the current directory', () => {
    const text = ['-e .', '.', './', '-e .[cli]', '.[docs,tests]', '-e ./[dev]', '-e .\\[windows]', '--editable=.[cli]', '.[cli] ; python_version >= "3.10"', ''].join('\n');
    expect(read(text)).toEqual([
      ['.', 'workspace', 1],
      ['.', 'workspace', 2],
      ['.', 'workspace', 3],
      ['.', 'workspace', 4],
      ['.', 'workspace', 5],
      ['.', 'workspace', 6],
      ['.', 'workspace', 7],
      ['.', 'workspace', 8],
      ['.', 'workspace', 9],
    ]);
  });

  it('keeps every other path with extras a local directory', () => {
    // pip needs at least one character between the brackets, and takes the last group off, so .[a[b] is the path .[a.
    const text = ['.[]', '..[dev]', './sub[cli]', '-e ./packages/client[cli]', '.[a][b]', '.[a[b]', 'sub/.[cli]', ''].join('\n');
    expect(read(text)).toEqual([
      ['.[]', 'directory', 1],
      ['..[dev]', 'directory', 2],
      ['./sub[cli]', 'directory', 3],
      ['./packages/client[cli]', 'directory', 4],
      ['.[a][b]', 'directory', 5],
      ['.[a[b]', 'directory', 6],
      ['sub/.[cli]', 'directory', 7],
    ]);
  });
});

describe('pip\'s strip_extras, read the same way (decision D-203)', () => {
  /**
   * pip 26.3, src/pip/_internal/utils/urls.py lines 69-78: the path without its extras, then the current directory test.
   * .\ (and .\[x]) is the current directory as pip on Windows reads it, where \ is a path separator; on POSIX pip looks
   * for a directory named .\, which does not exist, so the install fails. doctor reads a requirements file for every
   * platform, so it takes the Windows reading, as requirementsPaths lists \ among the separators; no file gets through.
   */
  const pip263 = (path: string) => (/^(.+)(\[[^\]]+\])$/u.exec(path)?.[1]?.trimEnd() ?? path).replace(/^\.[\/\\]?$/u, '.') === '.';
  const project = (path: string) => requirementsEntries(path, requirementsFormatOf(pip))[0]?.source === 'workspace';

  it('agrees with pip on short paths of dots, slashes, brackets, spaces and letters', () => {
    const alphabet = ['.', '/', '\\', '[', ']', ' ', 'a', ','];
    let checked = 0;
    const visit = (prefix: string, length: number): void => {
      if (prefix.startsWith('.') && !prefix.startsWith('. ') && prefix.trimEnd() === prefix) {
        expect(project(prefix), JSON.stringify(prefix)).toBe(pip263(prefix));
        checked += 1;
      }
      if (length === 0) return;
      for (const char of alphabet) visit(prefix + char, length - 1);
    };
    visit('.', 5);
    expect(checked).toBeGreaterThan(10_000);
  });

  it('reads a line of a million brackets in linear time', () => {
    const started = process.cpuUsage();
    expect(project(`.${'['.repeat(1_000_000)}]`)).toBe(false);
    expect(project(`.[${'a'.repeat(1_000_000)}]`)).toBe(true);
    const used = process.cpuUsage(started);
    expect((used.user + used.system) / 1000).toBeLessThan(5000);
  });
});

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = { fetch: () => Promise.reject(new Error('no network in tests')), now: () => new Date(), stdin: async () => '', osvData: () => undefined };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

/** A copy of the library with "-e .[brotli,cli,http2,socks]" in requirements.txt, shaped like httpx's. */
function library(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d203-'));
  temporary.push(directory);
  cpSync(SOURCE, directory, { recursive: true });
  mkdirSync(join(directory, '.git'));
  return directory;
}

type DoctorJson = { findings: { rule: string; level: string; message: string; location?: { line?: number } }[] };

describe('depcurfew init, apply and doctor on a library that installs itself with extras (decision D-203)', () => {
  it('exit 0, and doctor reports nothing about the project itself', async () => {
    const directory = library();
    expect((await exec('init', directory)).code).toBe(EXIT_OK);
    expect((await exec('apply', directory)).code).toBe(EXIT_OK);
    // apply wrote the build ban that doctor compares the project with.
    expect(readFileSync(join(directory, 'requirements.txt'), 'utf8')).toContain('--only-binary=:all:');
    const doctor = await exec('doctor', directory);
    expect(doctor.stdout).not.toContain('.[brotli,cli,http2,socks] is built from source');
    expect(doctor.code).toBe(EXIT_OK);
    const report = JSON.parse((await exec('doctor', '--json', directory)).stdout) as DoctorJson;
    expect(report.findings.filter((finding) => finding.level !== 'note')).toEqual([]);
  });

  it('also when depcurfew.json denies local directories', async () => {
    const directory = library();
    expect((await exec('init', directory)).code).toBe(EXIT_OK);
    const file = join(directory, 'depcurfew.json');
    const policy = JSON.parse(readFileSync(file, 'utf8')) as { sources: Record<string, string> };
    policy.sources['directory'] = 'deny';
    writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
    expect((await exec('apply', directory)).code).toBe(EXIT_OK);
    const report = JSON.parse((await exec('doctor', '--json', directory)).stdout) as DoctorJson;
    expect(report.findings.filter((finding) => finding.rule === 'lockfile-forbidden-source' || finding.rule === 'lockfile-install-scripts').filter((finding) => finding.level !== 'note')).toEqual([]);
    expect((await exec('doctor', directory)).code).toBe(EXIT_OK);
  });

  it('still reports a local directory with extras that is not the project', async () => {
    const directory = library();
    writeFileSync(join(directory, 'requirements.txt'), '-e .[cli]\n-e ./vendor/client[cli]\n');
    expect((await exec('init', directory)).code).toBe(EXIT_OK);
    expect((await exec('apply', directory)).code).toBe(EXIT_OK);
    const report = JSON.parse((await exec('doctor', '--json', directory)).stdout) as DoctorJson;
    const built = report.findings.filter((finding) => finding.rule === 'lockfile-install-scripts' && finding.level === 'error');
    expect(built.map((finding) => finding.message.split(' is built', 1)[0])).toEqual(['./vendor/client[cli]']);
  });
});
