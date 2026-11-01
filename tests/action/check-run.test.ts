// The "depcurfew doctor" check run (D-095, D-104): created with the workflow token over the API the runner names, on the
// head commit of a pull request, updated instead of added again on the same commit, with the findings as annotations,
// and never a reason for the step to fail. The API is a fake here; nothing goes on the network.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRunExternalId, checkRunName, checkRunSha, createCheckRun, fitSummary, type CheckRunAnnotation, type CheckRunContent, type CheckRunFetch } from '../../src/action-check-run.ts';
import { runAction } from '../../src/action.ts';
import { RULES } from '../../src/doctor/index.ts';
import { checkRunAnnotationNote, checkRunAnnotations } from '../../src/doctor/github.ts';
import { values } from '../../src/apply/facts.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { windows } from '../support/platform.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const FACTS = values(environment.githubActions.checkRuns)[0]!;
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const CONTENT: CheckRunContent = { name: 'depcurfew doctor', title: 'No problems found (13 checks: 13 passed)', summary: '## depcurfew doctor\n', conclusion: 'success' };

function event(payload: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-check-run-'));
  temporary.push(directory);
  const file = join(directory, 'event.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

const runner = (extra: Record<string, string> = {}) => ({ GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: MERGE, ...extra });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/**
 * A fake Checks API: the list answers `runs` (or `list`, a status or an error), create answers `create` with the id 7,
 * updates answer `update` (a status per request, the last one repeated).
 */
function api(options: { create?: number; list?: number | Error; runs?: unknown[]; update?: number[] } = {}): { fetch: CheckRunFetch; calls: Call[] } {
  const calls: Call[] = [];
  let updates = 0;
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ method: init.method, url, headers: init.headers, body: init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>) });
      const answer = (status: number, body: unknown = {}) => Promise.resolve({ status, json: () => Promise.resolve(body) });
      if (init.method === 'GET') {
        if (options.list instanceof Error) return Promise.reject(options.list);
        return answer(options.list ?? 200, { total_count: (options.runs ?? []).length, check_runs: options.runs ?? [] });
      }
      if (init.method === 'POST') return answer(options.create ?? 201, { id: 7 });
      const statuses = options.update ?? [200];
      return answer(statuses[Math.min(updates++, statuses.length - 1)] ?? 200);
    },
  };
}

/** Every request answered with one status. */
function recorder(status: number): { fetch: CheckRunFetch; calls: Call[] } {
  return api({ create: status, list: status, update: [status] });
}

const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST');
const patches = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PATCH');

function annotations(count: number): CheckRunAnnotation[] {
  return Array.from({ length: count }, (_, index) => ({ path: `f${index}`, start_line: 1, end_line: 1, annotation_level: 'warning', message: 'm', title: 't' }));
}

describe('the commit of the check', () => {
  it('is the head of a pull request, not the merge commit GITHUB_SHA names there', () => {
    expect(checkRunSha(runner({ GITHUB_EVENT_PATH: event({ pull_request: { head: { sha: HEAD } } }) }), FACTS)).toBe(HEAD);
  });

  it('is GITHUB_SHA for a push, and nothing without a valid one', () => {
    expect(checkRunSha(runner({ GITHUB_EVENT_PATH: event({ ref: 'refs/heads/main' }) }), FACTS)).toBe(MERGE);
    expect(checkRunSha({ GITHUB_SHA: 'not-a-sha' }, FACTS)).toBeUndefined();
  });
});

describe('createCheckRun', () => {
  it('looks for an earlier entry, then posts the result to the check runs API with the token in a header only', async () => {
    const fake = api();
    const line = await createCheckRun(runner({ GITHUB_EVENT_PATH: event({ pull_request: { head: { sha: HEAD } } }) }), 'secret-token', CONTENT, fake.fetch);
    expect(line).toBe(`depcurfew: added the check "depcurfew doctor" with the result to the commit ${HEAD.slice(0, 12)}\n`);
    expect(fake.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(fake.calls[0]?.url).toBe(`https://api.github.com/repos/owner/repo/commits/${HEAD}/check-runs?check_name=depcurfew%20doctor&filter=latest`);
    expect(fake.calls[0]?.body).toBeUndefined();
    expect(fake.calls[1]?.url).toBe('https://api.github.com/repos/owner/repo/check-runs');
    for (const call of fake.calls) expect(call.headers).toMatchObject({ authorization: 'Bearer secret-token', 'x-github-api-version': '2022-11-28' });
    expect(fake.calls[1]?.body).toEqual({
      name: 'depcurfew doctor',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      external_id: checkRunExternalId([]),
      output: { title: CONTENT.title, summary: CONTENT.summary },
    });
    expect(checkRunExternalId([])).toMatch(/^depcurfew:[0-9a-f]{64}$/u);
    expect(JSON.stringify(fake.calls.map((call) => [call.url, call.body]))).not.toContain('secret-token');
  });

  it('updates the entry an earlier run left on the commit instead of adding a second one', async () => {
    const runs = [
      { id: 3, name: 'depcurfew doctor', external_id: 'other', output: { annotations_count: 0 } },
      { id: 5, name: 'depcurfew doctor', external_id: 'depcurfew', output: { annotations_count: 0 } },
    ];
    const fake = api({ runs });
    const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: annotations(2) }, fake.fetch);
    expect(line).toBe(`depcurfew: updated the check "depcurfew doctor" on the commit ${MERGE.slice(0, 12)} with the result of this run and 2 annotations, instead of adding a second one\n`);
    expect(posts(fake.calls)).toEqual([]);
    expect(patches(fake.calls)).toHaveLength(1);
    expect(patches(fake.calls)[0]?.url).toBe('https://api.github.com/repos/owner/repo/check-runs/5');
    expect(patches(fake.calls)[0]?.body).toEqual({
      status: 'completed',
      conclusion: 'success',
      external_id: checkRunExternalId(annotations(2)),
      output: { title: CONTENT.title, summary: CONTENT.summary, annotations: annotations(2) },
    });
  });

  it('keeps the annotations of an entry that has exactly those of this run, since updates only append', async () => {
    const fake = api({ runs: [{ id: 5, name: 'depcurfew doctor', external_id: checkRunExternalId(annotations(2)), output: { annotations_count: 2 } }] });
    const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: annotations(2) }, fake.fetch);
    expect(line).toContain('with the result of this run, instead of adding a second one; it keeps the annotations it has\n');
    expect(posts(fake.calls)).toEqual([]);
    expect(patches(fake.calls)).toHaveLength(1);
    expect((patches(fake.calls)[0]?.body?.['output'] as Record<string, unknown>)['annotations']).toBeUndefined();
  });

  it('adds a new entry instead of leaving other annotations under this result, and marks the earlier one as replaced', async () => {
    // An earlier run on the commit had errors (push), this one is clean (pull_request); or an earlier version of the
    // action, without the fingerprint; or the same findings, of which only some were added.
    for (const run of [
      { external_id: checkRunExternalId(annotations(2)), annotations_count: 2, now: [] as CheckRunAnnotation[] },
      { external_id: 'depcurfew', annotations_count: 2, now: annotations(2) },
      { external_id: checkRunExternalId(annotations(60)), annotations_count: 50, now: annotations(60) },
    ]) {
      const fake = api({ runs: [{ id: 5, name: 'depcurfew doctor', external_id: run.external_id, output: { annotations_count: run.annotations_count } }] });
      const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: run.now }, fake.fetch);
      expect(posts(fake.calls)).toHaveLength(1);
      expect(posts(fake.calls)[0]?.body).toMatchObject({ external_id: checkRunExternalId(run.now), conclusion: 'success' });
      const replaced = patches(fake.calls).filter((call) => call.url.endsWith('/check-runs/5'));
      expect(replaced).toHaveLength(1);
      expect(replaced[0]?.body).toEqual({
        conclusion: 'neutral',
        external_id: 'depcurfew:replaced',
        output: {
          title: 'Replaced by a later run of depcurfew doctor on this commit',
          summary:
            'A later run of depcurfew doctor on this commit had a different result, and annotations cannot be removed from a check, so its result is in a new "depcurfew doctor" entry. The annotations of this entry are from the earlier run.\n',
        },
      });
      expect(line).toMatch(/to the commit [0-9a-f]{12}, next to an earlier one with other annotations(?:; .+)?; the earlier one, whose annotations are out of date, now says it is replaced\n$/u);
    }
  });

  it('never takes an entry it marked as replaced for the current one, in whatever order the API lists them', async () => {
    const replaced = { id: 5, name: 'depcurfew doctor', external_id: 'depcurfew:replaced', output: { annotations_count: 2 } };
    const current = { id: 6, name: 'depcurfew doctor', external_id: checkRunExternalId([]), output: { annotations_count: 0 } };
    for (const runs of [[replaced, current], [current, replaced]]) {
      const fake = api({ runs });
      await createCheckRun(runner(), 't', CONTENT, fake.fetch);
      expect(posts(fake.calls)).toEqual([]);
      expect(patches(fake.calls).map((call) => call.url)).toEqual(['https://api.github.com/repos/owner/repo/check-runs/6']);
    }
    // Only a replaced entry: a new one, and the replaced one is left as it is.
    const fake = api({ runs: [replaced] });
    await createCheckRun(runner(), 't', CONTENT, fake.fetch);
    expect(posts(fake.calls)).toHaveLength(1);
    expect(patches(fake.calls)).toEqual([]);
  });

  it('says so on the same line when the earlier entry cannot be marked as replaced', async () => {
    const fake = api({ runs: [{ id: 5, name: 'depcurfew doctor', external_id: 'depcurfew', output: { annotations_count: 1 } }], update: [403] });
    const line = await createCheckRun(runner(), 't', CONTENT, fake.fetch);
    expect(line).toBe(
      `depcurfew: added the check "depcurfew doctor" with the result to the commit ${MERGE.slice(0, 12)}, next to an earlier one with other annotations; the earlier one, whose annotations are out of date, could not be marked as replaced: the GitHub API answered HTTP 403\n`,
    );
  });

  it('adds a new entry when there is no earlier one of its own, or the lookup or the update fails', async () => {
    for (const options of [
      { runs: [{ id: 3, name: 'depcurfew doctor (other)', external_id: 'depcurfew' }, { id: 4, name: 'depcurfew doctor', external_id: null }] },
      { list: 403 },
      { list: new Error('timed out') },
      { runs: [{ id: 5, name: 'depcurfew doctor', external_id: 'depcurfew', output: { annotations_count: 0 } }], update: [404] },
    ]) {
      const fake = api(options);
      const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: annotations(1) }, fake.fetch);
      expect(line).toBe(`depcurfew: added the check "depcurfew doctor" with the result and 1 annotation to the commit ${MERGE.slice(0, 12)}\n`);
      expect(posts(fake.calls)).toHaveLength(1);
    }
  });

  it('sends at most 50 annotations per request: the rest in updates, which append them', async () => {
    const fake = api();
    const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: annotations(120) }, fake.fetch);
    expect(line).toBe(`depcurfew: added the check "depcurfew doctor" with the result and 120 annotations to the commit ${MERGE.slice(0, 12)}\n`);
    const output = (call: Call | undefined) => call?.body?.['output'] as { title: string; summary: string; annotations: CheckRunAnnotation[] };
    expect(output(posts(fake.calls)[0]).annotations).toEqual(annotations(120).slice(0, 50));
    expect(patches(fake.calls).map((call) => call.url)).toEqual(['https://api.github.com/repos/owner/repo/check-runs/7', 'https://api.github.com/repos/owner/repo/check-runs/7']);
    expect(patches(fake.calls).map((call) => output(call).annotations.length)).toEqual([50, 20]);
    expect(output(patches(fake.calls)[1])).toMatchObject({ title: CONTENT.title, summary: CONTENT.summary });
  });

  it('says how many annotations are missing when an update fails, on the same line', async () => {
    const fake = api({ update: [200, 422] });
    const line = await createCheckRun(runner(), 't', { ...CONTENT, annotations: annotations(120) }, fake.fetch);
    expect(line).toBe(
      `depcurfew: added the check "depcurfew doctor" with the result and 100 annotations to the commit ${MERGE.slice(0, 12)}; 20 more annotations could not be added: the GitHub API answered HTTP 422\n`,
    );
  });

  it('says how to allow it when the token may not create checks, and never prints the token', async () => {
    const line = await createCheckRun(runner(), 'secret-token', CONTENT, recorder(403).fetch);
    expect(line).toContain('Add "checks: write" to the permissions of the job, or set the input check-run to false');
    expect(line).not.toContain('secret-token');
  });

  it('says why when the API does not answer or the runner variables are missing', async () => {
    const failing: CheckRunFetch = () => Promise.reject(new Error('timed out'));
    expect(await createCheckRun(runner(), 't', CONTENT, failing)).toContain('the GitHub API did not answer (timed out)');
    expect(await createCheckRun({}, 't', CONTENT, recorder(201).fetch)).toContain('GITHUB_API_URL, GITHUB_REPOSITORY or the commit is not set');
    // A URL that is set but not https is named as such, with what to do (decision D-116), and nothing is sent.
    const plain = recorder(201);
    const line = await createCheckRun(runner({ GITHUB_API_URL: 'http://user:secret@plain.example' }), 't', CONTENT, plain.fetch);
    expect(line).toBe(
      'depcurfew: the depcurfew doctor check was not added: GITHUB_API_URL is not an https URL, and depcurfew sends the token only over https; set GITHUB_API_URL to the https address of the GitHub API, or leave it to the runner, which sets it\n',
    );
    expect(line).not.toContain('secret');
    expect(plain.calls).toEqual([]);
  });
});

describe('the annotations of the check', () => {
  const finding = (level: 'error' | 'warning' | 'note', file: string, line?: number) => ({
    rule: 'config-drift',
    level,
    message: 'a\u001b[2Kb',
    location: line === undefined ? { file } : { file, line },
    fix: 'do it',
  });
  const report = (findings: ReturnType<typeof finding>[]) => ({ schemaVersion: 1 as const, policy: 'valid' as const, findings, notices: [] });

  it('map the levels, use line 1 for a whole file and show control characters as text', () => {
    const { annotations, omitted } = checkRunAnnotations(report([finding('note', 'a.json'), finding('warning', 'b.yml', 4), finding('error', 'c.toml', 2)]), RULES, () => true);
    expect(omitted).toBe(0);
    expect(annotations.map((entry) => [entry.annotation_level, entry.path, entry.start_line, entry.end_line])).toEqual([
      ['failure', 'c.toml', 2, 2],
      ['warning', 'b.yml', 4, 4],
      ['notice', 'a.json', 1, 1],
    ]);
    expect(annotations[0]?.message).toBe('a\\x1b[2Kb\nFix: do it');
    expect(annotations[0]?.title).toBe('depcurfew: config-drift');
  });

  it('leave out files outside the workspace, missing ones and paths with control characters, and count them', () => {
    const findings = [finding('error', '../outside.json', 1), finding('error', '/abs.json'), finding('error', 'missing.json'), finding('error', 'line\nbreak.json'), finding('error', 'ok.json')];
    const { annotations, omitted } = checkRunAnnotations(report(findings), RULES, (file) => file !== 'missing.json');
    expect(annotations.map((entry) => entry.path)).toEqual(['ok.json']);
    expect(omitted).toBe(4);
    expect(checkRunAnnotationNote(omitted)).toBe(
      '\n4 findings are not shown as annotations on the files: the check gets at most 100, errors first, and only on files in the workspace. The job log lists every finding.\n',
    );
    expect(checkRunAnnotationNote(0)).toBe('');
  });

  it('stop at 100, errors first, and stay within the limits of a message and a title', () => {
    const findings = [...Array.from({ length: 80 }, (_, index) => finding('warning', `w${index}`)), ...Array.from({ length: 30 }, (_, index) => finding('error', `e${index}`))];
    const { annotations, omitted } = checkRunAnnotations(report(findings), RULES, () => true);
    expect(annotations).toHaveLength(100);
    expect(annotations.slice(0, 30).every((entry) => entry.annotation_level === 'failure')).toBe(true);
    expect(omitted).toBe(10);
    const long = { ...finding('error', 'x'), message: '\u00e9'.repeat(40_000), rule: 'r'.repeat(300) };
    const [cut] = checkRunAnnotations(report([long]), RULES, () => true).annotations;
    expect(Buffer.byteLength(cut?.message ?? '')).toBeLessThanOrEqual(FACTS.annotationMessageMaxBytes);
    expect(cut?.message.endsWith('...')).toBe(true);
    expect(cut?.title.length).toBe(FACTS.annotationTitleMaxLength);
  });
});

describe('the summary of the check', () => {
  it('stays within the limit of the API, cut at a line with a note', () => {
    const long = Array.from({ length: 10_000 }, (_, index) => `| row ${index} |`).join('\n');
    const fitted = fitSummary(long, FACTS.summaryMaxLength);
    expect(fitted.length).toBeLessThanOrEqual(FACTS.summaryMaxLength);
    expect(fitted).toMatch(/\| row \d+ \|\n\nThe rest did not fit; the job log and the job summary have everything\.\n$/u);
    expect(fitSummary('short', 100)).toBe('short');
  });

  it('names the directory when it is not the workspace root', () => {
    expect(checkRunName('')).toBe('depcurfew doctor');
    expect(checkRunName('packages/app')).toBe('depcurfew doctor (packages/app)');
  });
});

describe('the Action and the check', () => {
  const fixture = (name: string) => join(import.meta.dirname, '..', 'fixtures', 'doctor', name, 'repo');
  const collect = (env: Record<string, string>) => {
    const contents: CheckRunContent[] = [];
    const reports = mkdtempSync(join(tmpdir(), 'depcurfew-sarif-'));
    temporary.push(reports);
    runAction({ GITHUB_WORKSPACE: fixture(env['FIXTURE'] ?? ''), INPUT_SARIF_FILE: join(reports, 'r.sarif'), ...env }, {
      log: () => undefined,
      summary: () => undefined,
      checkRun: (content) => contents.push(content),
    });
    return contents;
  };

  it('passes a clean result with every check in the summary, and counts the checks that do not apply', () => {
    const [content] = collect({ FIXTURE: 'bot-cooldown-mismatch/passes-consistent' });
    expect(content).toMatchObject({ name: 'depcurfew doctor', conclusion: 'success', annotations: [] });
    expect(content?.title).toBe('No problems found (16 checks: 7 passed, 5 not applicable, 4 skipped)');
    expect(content?.summary).toContain('| Result | Check | Rule |');
    expect(content?.summary).toContain('| not applicable | Python tools read their settings where they are written | `python-config-ignored` |');
  });

  it('fails with errors, or is neutral when the step does not fail on them', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter' })[0]).toMatchObject({ conclusion: 'failure', title: expect.stringMatching(/^1 error \(/u) as unknown });
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter', INPUT_FAIL_ON_ERROR: 'false' })[0]?.conclusion).toBe('neutral');
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter', INPUT_FAIL_ON: 'warning', INPUT_FAIL_ON_ERROR: 'false' })[0]?.conclusion).toBe('neutral');
  });

  it('is neutral with warnings, or fails with fail-on: warning', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-security-recheck' })[0]?.conclusion).toBe('neutral');
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-security-recheck', INPUT_FAIL_ON: 'warning' })[0]?.conclusion).toBe('failure');
  });

  it('fails when the input fail-on is not error or warning', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/passes-consistent', INPUT_FAIL_ON: 'never' })[0]).toMatchObject({ conclusion: 'failure', title: 'depcurfew could not check the repository' });
  });

  it('carries the findings as annotations on their lines, with the fix and the rule', () => {
    const [content] = collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter' });
    expect(content?.annotations).toHaveLength(1);
    expect(content?.annotations?.[0]).toMatchObject({ path: '.github/dependabot.yml', start_line: 7, end_line: 7, annotation_level: 'failure', title: 'depcurfew: bot-cooldown-mismatch' });
    expect(content?.annotations?.[0]?.message).toMatch(/^Dependabot .+\nFix: .+$/u);
    expect(content?.summary).not.toContain('not shown as annotations');
  });

  it('is not made with check-run: false', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/passes-consistent', INPUT_CHECK_RUN: 'false' })).toEqual([]);
  });
});
