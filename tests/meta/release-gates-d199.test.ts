// Decision D-199: the gates of the release workflow do what they say. The scripts of three steps are taken from
// release.yml as they are and run with bash -e, as GitHub runs a step without a shell of its own: the check that
// CHANGELOG.md starts with the section of the tag (build job), the wait for CI on the tagged commit (ci-passed job,
// with a gh that answers from runs written here and applies the job's jq filter with jq), and the comparison of the
// fresh build with the package of the build job (rebuild job, with two packages made here). The workflow runs on
// Linux, so these tests run on POSIX systems only, and the ci-passed ones only where jq is installed.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { windows } from '../support/platform.ts';

interface Step {
  run?: string;
  env?: Record<string, string | number>;
}

const workflow = parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
const stepOf = (job: string, marker: string): Step => {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.run?.includes(marker));
  if (step === undefined) throw new Error(`release.yml: no step of the job ${job} runs ${marker}`);
  return step;
};

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d199-gates-'));
  temporary.push(directory);
  return directory;
}

const has = (command: string) => !windows && spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

/** Runs the script of a step with bash -e, with the literal values of its env, the given variables and PATH. */
function runStep(step: Step, cwd: string, env: Record<string, string>, path: string[] = []): { status: number | null; output: string } {
  const literal = Object.fromEntries(
    Object.entries(step.env ?? {})
      .map(([name, value]) => [name, String(value)] as const)
      .filter(([, value]) => !value.includes('${{')),
  );
  const script = join(cwd, '.step.sh');
  writeFileSync(script, step.run ?? '');
  const result = spawnSync('bash', ['-e', script], {
    cwd,
    encoding: 'utf8',
    env: { PATH: [...path, process.env['PATH'] ?? ''].join(delimiter), ...literal, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(!has('bash'))('the CHANGELOG step of the build job (decision D-199)', () => {
  const step = stepOf('build', "grep -n -m 1 '^## ' CHANGELOG.md");
  const check = (changelog: string | undefined, tag = 'v1.6.1') => {
    const directory = scratch();
    if (changelog !== undefined) writeFileSync(join(directory, 'CHANGELOG.md'), changelog);
    return runStep(step, directory, { TAG: tag });
  };

  it('passes when the first section is the version of the tag', () => {
    const result = check('# Changelog\n\nAll notable changes.\n\n## 1.6.1\n\n### Fixes\n\n- A fix.\n\n## 1.6.0\n');
    expect(result).toMatchObject({ status: 0 });
    expect(result.output).toContain('CHANGELOG.md starts with the section ## 1.6.1');
  });

  it.each([
    ['## Unreleased first', '# Changelog\n\n## Unreleased\n\n- A fix.\n\n## 1.6.0\n', 3, '## Unreleased'],
    ['an older section first', '# Changelog\n\n## 1.6.0\n\n## 1.6.1\n', 3, '## 1.6.0'],
    ['a longer version', '# Changelog\n\n## 1.6.10\n', 3, '## 1.6.10'],
    ['a date after the version', '# Changelog\n\n## 1.6.1 (2026-11-20)\n', 3, '## 1.6.1 (2026-11-20)'],
  ])('fails with an error at the line of the first section for %s', (_name, changelog, line, first) => {
    const result = check(changelog);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`::error file=CHANGELOG.md,line=${line}::depcurfew: the first section of CHANGELOG.md is "${first}", not "## 1.6.1" of the tag v1.6.1`);
    expect(result.output).toContain('delete the tag and push it again on the merge commit');
  });

  it('fails when CHANGELOG.md has no section or is missing', () => {
    for (const changelog of ['# Changelog\n\nNothing yet.\n', undefined]) {
      const result = check(changelog);
      expect(result.status).toBe(1);
      expect(result.output).toContain('::error file=CHANGELOG.md::depcurfew: CHANGELOG.md has no section');
    }
  });
});

const SHA = '980d2a8bb9838b133945f9da654ad881d5d113e2';
type Run = { event: string; status: string; conclusion: string | null };
const runs = (...list: Run[]) => JSON.stringify({ total_count: list.length, workflow_runs: list });
const push = (status: string, conclusion: string | null = null): Run => ({ event: 'push', status, conclusion });

/** A gh that records its arguments and answers the n-th question about a workflow with <workflow>.<n> (or the last). */
const FAKE_GH = `#!/usr/bin/env bash
path=''
filter=''
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) filter="$2"; shift 2 ;;
    repos/*) path="$1"; shift ;;
    *) shift ;;
  esac
done
workflow="\${path%/runs}"
workflow="\${workflow##*/}"
echo "$workflow" >> "$FAKE_GH/asked"
count="$(grep -c -x -F "$workflow" "$FAKE_GH/asked")"
while [ "$count" -gt 1 ] && [ ! -e "$FAKE_GH/$workflow.$count" ]; do count=$((count - 1)); done
answer="$FAKE_GH/$workflow.$count"
if [ ! -e "$answer" ] || [ "$(cat "$answer")" = fail ]; then echo 'gh: Server Error (HTTP 502)' >&2; exit 1; fi
jq -r "$filter" "$answer"
`;

describe.skipIf(!has('bash') || !has('jq'))('the ci-passed job (decision D-199)', () => {
  const step = workflow.jobs['ci-passed']?.steps[0] ?? {};

  function wait(answers: Record<string, string>, env: Record<string, string> = {}) {
    const directory = scratch();
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(directory, 'asked'), '');
    for (const [name, answer] of Object.entries(answers)) writeFileSync(join(directory, name), answer);
    const result = runStep(step, directory, { FAKE_GH: directory, GITHUB_REPOSITORY: 'DevXord/depcurfew', GITHUB_SHA: SHA, GITHUB_REF_NAME: 'v1.6.1', GH_TOKEN: 'token', INTERVAL: '0', ...env }, [bin]);
    const asked = readFileSync(join(directory, 'asked'), 'utf8').split('\n').filter((line) => line !== '');
    return { ...result, asked };
  }

  it('waits while a run of the commit is in progress, and passes once each workflow has a successful run', () => {
    const result = wait({ 'ci.yml.1': runs(push('queued')), 'ci.yml.2': runs(push('in_progress')), 'ci.yml.3': runs(push('completed', 'success')), 'action-test.yml.1': runs(push('completed', 'success')) });
    expect(result.status).toBe(0);
    expect(result.asked).toEqual(['ci.yml', 'ci.yml', 'ci.yml', 'action-test.yml']);
    expect(result.output).toContain(`ci.yml passed on ${SHA}`);
    expect(result.output).toContain(`action-test.yml passed on ${SHA}`);
  });

  it('passes on the first successful run when another run of the commit failed (the run of main and the run of the tag)', () => {
    const result = wait({
      'ci.yml.1': runs(push('completed', 'failure'), push('in_progress')),
      'ci.yml.2': runs(push('completed', 'failure'), push('completed', 'success')),
      'action-test.yml.1': runs({ event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }),
    });
    expect(result.status).toBe(0);
  });

  it('waits for a run that does not exist yet', () => {
    const result = wait({ 'ci.yml.1': runs(), 'ci.yml.2': runs(push('completed', 'success')), 'action-test.yml.1': runs(push('completed', 'success')) });
    expect(result.status).toBe(0);
    expect(result.asked).toEqual(['ci.yml', 'ci.yml', 'action-test.yml']);
  });

  it('fails at once, saying what to re-run, when every run of the commit has finished without success', () => {
    const result = wait({ 'ci.yml.1': runs(push('completed', 'failure'), push('completed', 'cancelled')), 'action-test.yml.1': runs(push('completed', 'success')) });
    expect(result.status).toBe(1);
    expect(result.asked).toEqual(['ci.yml']);
    expect(result.output).toContain(`::error::depcurfew: no run of ci.yml on ${SHA}, the commit of v1.6.1, has passed, so nothing is staged: re-run the failed jobs of its latest run`);
    expect(result.output).toContain('then re-run the failed jobs of this Release run');
  });

  it('does not count runs of pull requests, and gives up after LIMIT seconds with an error', () => {
    const result = wait({ 'ci.yml.1': runs({ event: 'pull_request', status: 'completed', conclusion: 'success' }) }, { LIMIT: '0' });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`::error::depcurfew: ci.yml has not passed on ${SHA}, the commit of v1.6.1, within 0 minutes, so nothing is staged`);
  });

  it('asks again after a failed request, and names the failure when it gives up', () => {
    expect(wait({ 'ci.yml.1': 'fail', 'ci.yml.2': runs(push('completed', 'success')), 'action-test.yml.1': runs(push('completed', 'success')) }).status).toBe(0);
    const result = wait({ 'ci.yml.1': 'fail' }, { LIMIT: '0' });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::error::depcurfew: ci.yml has not passed on .* \(the last request for its runs failed\)/u);
  });
});

describe.skipIf(!has('bash') || !has('tar') || !has('diff'))('the comparison of the rebuild job (decision D-199)', () => {
  const step = stepOf('rebuild', 'diff -rq');
  const TARBALL = 'depcurfew-1.6.1.tgz';

  /** $RUNNER_TEMP with the package of the build job in built/ and the fresh one in rebuilt/, from name -> content. */
  function packages(built: Record<string, string>, rebuilt: Record<string, string>): string {
    const temp = scratch();
    for (const [name, files] of [['built', built], ['rebuilt', rebuilt]] as const) {
      const tree = join(temp, `${name}-tree`);
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(join(tree, 'package', file, '..'), { recursive: true });
        writeFileSync(join(tree, 'package', file), content);
      }
      mkdirSync(join(temp, name));
      expect(spawnSync('tar', ['-czf', join(temp, name, TARBALL), '-C', tree, 'package']).status).toBe(0);
      rmSync(tree, { recursive: true });
    }
    return temp;
  }

  const compare = (temp: string, integrity: string, rebuilt: string) => runStep(step, temp, { RUNNER_TEMP: temp, TARBALL, INTEGRITY: integrity, REBUILT: rebuilt, TAG: 'v1.6.1' });

  it('passes when the fresh build has the integrity of the package of the build job', () => {
    const temp = scratch();
    const result = compare(temp, 'sha512-same', 'sha512-same');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`A fresh build of v1.6.1 packs ${TARBALL} with the integrity of the build job: sha512-same`);
  });

  it('fails naming the files that differ, and says not to re-run the jobs', () => {
    const temp = packages({ 'package.json': '{}', 'dist/index.d.ts': 'a', 'dist/old.js': '' }, { 'package.json': '{}', 'dist/index.d.ts': 'b', 'dist/new.js': '' });
    const result = compare(temp, 'sha512-built', 'sha512-rebuilt');
    expect(result.status).toBe(1);
    const error = result.output.split('\n').find((line) => line.startsWith('::error::')) ?? '';
    expect(error).toContain(`::error::depcurfew: a fresh build of v1.6.1 packs ${TARBALL} with sha512-rebuilt, not with sha512-built as the build job did, so nothing is staged`);
    for (const file of ['dist/index.d.ts', 'dist/old.js', 'dist/new.js']) expect(error).toContain(file);
    expect(error).not.toContain('package.json');
    expect(error).toContain('do not re-run the jobs');
  });

  it('says so when the files are the same and only the archives differ', () => {
    const temp = packages({ 'package.json': '{}' }, { 'package.json': '{}' });
    const result = compare(temp, 'sha512-built', 'sha512-rebuilt');
    expect(result.status).toBe(1);
    expect(result.output).toContain('the files in both packages are the same, the archives differ');
  });

  it('fails when an output it needs is empty (a wiring error), without comparing anything', () => {
    const temp = scratch();
    for (const [integrity, rebuilt] of [['', 'sha512-x'], ['sha512-x', '']] as const) {
      const result = compare(temp, integrity, rebuilt);
      expect(result.status).toBe(1);
      expect(result.output).toContain('::error::depcurfew: the rebuild job got no integrity');
    }
  });
});
