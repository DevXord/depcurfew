// Decision D-191: the files a requirements file includes (-r, -c) are followed by their real path and only so far.
// Two symlinks back to the directory (d -> ., e -> .) gave 2^40 distinct paths to the same file, and a file that
// includes the next one twice gave 2^depth visits in the reading of --only-binary, so doctor, apply, explain and the
// GitHub Action never finished (found by the review of 1.6.0, already in 1.5.2). The reading of --only-binary works out
// what each file does once; past the limits depcurfew says so.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { formatControlAfter, formatControlFacts } from '../../src/apply/pip-includes.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { requirementsLongOptions } from '../../src/doctor/python.ts';
import { requirementsFormatOf } from '../../src/doctor/python-lockfiles.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { cpuNow } from '../support/cpu-time.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: ['pip'] });

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d191-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/** CPU seconds of `action` (tests/support/cpu-time.ts). */
async function seconds(action: () => unknown): Promise<number> {
  const start = cpuNow();
  await action();
  return (cpuNow() - start) / 1000;
}

async function explain(root: string): Promise<number> {
  const fetch = (async () => {
    throw new Error('offline');
  }) as unknown as FetchLike;
  return run(['explain', root], { stdout: () => {}, stderr: () => {} }, { fetch, now: () => new Date(), stdin: async () => '' });
}

function reading() {
  const pip = knowledgeBase.find((tool) => tool.id === 'pip');
  const facts = pip === undefined ? undefined : formatControlFacts(pip);
  if (pip === undefined || facts === undefined) throw new Error('pip facts');
  const format = requirementsFormatOf(pip);
  return { facts, format, longOptions: requirementsLongOptions(format) };
}

/** requirements.txt and a1.txt to a20.txt, each including the next one twice; a20.txt has `last`. */
function doubled(last: string): Record<string, string> {
  const files: Record<string, string> = { 'requirements.txt': '--only-binary=:all:\nrequests==2.32.3\n-r a1.txt\n-r a1.txt\n', 'depcurfew.json': POLICY };
  for (let level = 1; level < 20; level++) files[`a${level}.txt`] = `-r a${level + 1}.txt\n-r a${level + 1}.txt\n`;
  files['a20.txt'] = last;
  return files;
}

/** The messages of the unreadable-config findings of doctor. */
function unreadable(root: string): string[] {
  return runDoctor(root)
    .findings.filter((finding) => finding.rule === 'unreadable-config')
    .map((finding) => finding.message);
}

describe('requirements files that include each other (decision D-191)', () => {
  it.skipIf(process.platform === 'win32')('follows two symlinks back to the directory once, in doctor, apply and explain', async () => {
    const root = repository({ 'requirements.txt': '--only-binary=:all:\nrequests==2.32.3\n-r d/requirements.txt\n-r e/requirements.txt\n', 'depcurfew.json': POLICY });
    symlinkSync('.', join(root, 'd'));
    symlinkSync('.', join(root, 'e'));
    expect(await seconds(() => runDoctor(root))).toBeLessThan(3);
    expect(await seconds(() => applyProject(root, { write: false }))).toBeLessThan(3);
    expect(await seconds(() => explain(root))).toBeLessThan(3);
    expect(unreadable(root)).toEqual([]);
  });

  it('reads a file that includes the next one twice, twenty levels deep, in linear time and to the end', async () => {
    const root = repository(doubled('idna==3.10\n'));
    expect(await seconds(() => runDoctor(root))).toBeLessThan(3);
    expect(await seconds(() => applyProject(root, { write: false }))).toBeLessThan(3);
    expect(unreadable(root)).toEqual([]);
    // 2^20 includes, read to the end: the switch holds, or the last file undoes it.
    for (const [last, expected] of [
      ['idna==3.10\n', { onlyAll: true, from: 'requirements.txt', stopped: false }],
      ['--no-binary=:all:\n', { onlyAll: false, from: undefined, stopped: false }],
      ['--only-binary=:none:\n--only-binary=:all:\n', { onlyAll: true, from: 'a20.txt', stopped: false }],
    ] as const) {
      const files = doubled(last);
      let result: ReturnType<typeof formatControlAfter> | undefined;
      expect(await seconds(() => (result = formatControlAfter((file) => files[file], 'requirements.txt', reading())))).toBeLessThan(1);
      expect(result, last).toEqual(expected);
    }
  });

  it('stops reading --only-binary when each file includes the next twice and the last one the first, and says so', { timeout: 60_000 }, async () => {
    // a20.txt includes requirements.txt, which is on the way, so what each file does depends on the way to it.
    const root = repository(doubled('-r requirements.txt\nidna==3.10\n'));
    expect(await seconds(() => runDoctor(root))).toBeLessThan(3);
    expect(unreadable(root)).toEqual([expect.stringContaining('requirements.txt includes more than 1000 requirements files, or the same ones so many times over, that depcurfew stops following them, so it cannot tell whether --only-binary=:all: holds there')]);
  });

  // Writing 1,500 files takes seconds on a Windows runner, so the clock gets room; what is limited is the CPU time of
  // depcurfew (decision D-188).
  it('stops after 1000 included files and says so, quickly', { timeout: 60_000 }, async () => {
    const files: Record<string, string> = { 'requirements.txt': 'requests==2.32.3\n-r a1.txt\n', 'depcurfew.json': POLICY };
    for (let level = 1; level < 1500; level++) files[`a${level}.txt`] = `-r a${level + 1}.txt\n`;
    files['a1500.txt'] = 'idna==3.10\n';
    const root = repository(files);
    let report: ReturnType<typeof applyProject> | undefined;
    expect(await seconds(() => (report = applyProject(root, { write: false })))).toBeLessThan(5);
    expect(report?.warningDetails.filter((warning) => warning.code === 'requirements-include-unread').map((warning) => warning.message)).toEqual([
      expect.stringContaining('requirements.txt includes more than 1000 requirements files, which depcurfew does not follow'),
    ]);
    expect(unreadable(root)).toEqual(expect.arrayContaining([expect.stringContaining('requirements.txt includes more than 1000 requirements files')]));
  });
});
