// The "depcurfew doctor" check run (D-095): created with the workflow token over the API the runner names, on the head
// commit of a pull request, and never a reason for the step to fail. The API is a fake here; nothing goes on the network.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRunName, checkRunSha, createCheckRun, fitSummary, type CheckRunContent, type CheckRunFetch } from '../../src/action-check-run.ts';
import { runAction } from '../../src/action.ts';
import { values } from '../../src/apply/facts.ts';
import { environment } from '../../src/knowledge/environment.ts';

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

function recorder(status: number): { fetch: CheckRunFetch; calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] } {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return Promise.resolve({ status });
    },
  };
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
  it('posts the result to the check runs API with the token in a header only', async () => {
    const api = recorder(201);
    const line = await createCheckRun(runner({ GITHUB_EVENT_PATH: event({ pull_request: { head: { sha: HEAD } } }) }), 'secret-token', CONTENT, api.fetch);
    expect(line).toBe(`depcurfew: added the check "depcurfew doctor" with the result to the commit ${HEAD.slice(0, 12)}\n`);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/check-runs');
    expect(api.calls[0]?.headers).toMatchObject({ authorization: 'Bearer secret-token', 'x-github-api-version': '2022-11-28' });
    expect(api.calls[0]?.body).toEqual({
      name: 'depcurfew doctor',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      output: { title: CONTENT.title, summary: CONTENT.summary },
    });
    expect(JSON.stringify(api.calls[0]?.body)).not.toContain('secret-token');
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
    expect(await createCheckRun(runner({ GITHUB_API_URL: 'http://plain.example' }), 't', CONTENT, recorder(201).fetch)).toContain('is not set');
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

  it('passes a clean result with every check in the summary', () => {
    const [content] = collect({ FIXTURE: 'bot-cooldown-mismatch/passes-consistent' });
    expect(content).toMatchObject({ name: 'depcurfew doctor', conclusion: 'success' });
    expect(content?.title).toMatch(/^No problems found \(\d+ checks: \d+ passed, \d+ skipped\)$/u);
    expect(content?.summary).toContain('| Result | Check | Rule |');
  });

  it('fails with errors, or is neutral when the step does not fail on them', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter' })[0]).toMatchObject({ conclusion: 'failure', title: expect.stringMatching(/^1 error \(/u) as unknown });
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/fires-dependabot-shorter', INPUT_FAIL_ON_ERROR: 'false' })[0]?.conclusion).toBe('neutral');
  });

  it('is not made with check-run: false', () => {
    expect(collect({ FIXTURE: 'bot-cooldown-mismatch/passes-consistent', INPUT_CHECK_RUN: 'false' })).toEqual([]);
  });
});
