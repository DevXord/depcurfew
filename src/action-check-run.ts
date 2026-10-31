// The "depcurfew doctor" check run (decision D-095): the result and every check, in the Checks tab of a pull request
// next to the code scanning entry, whose text GitHub writes itself and which lists alerts only. Created with the
// workflow token over the GitHub API that the runner names; without the checks: write permission the API refuses,
// and the step only says so in the log. Nothing here fails the step.
import { readFileSync } from 'node:fs';
import { values } from './apply/facts.ts';
import { environment } from './knowledge/environment.ts';
import type { CheckRunsKnowledge } from './knowledge/types.ts';

export interface CheckRunContent {
  /** "depcurfew doctor", with the directory when it is not the workspace root, so that several runs stay apart. */
  name: string;
  title: string;
  /** Markdown, cut to the limit of the API. */
  summary: string;
  conclusion: 'success' | 'neutral' | 'failure';
}

export type CheckRunFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export const CHECK_RUN_NAME = 'depcurfew doctor';

/** The name of the check: with the directory when it is not the workspace root. */
export function checkRunName(directory: string): string {
  return directory === '' ? CHECK_RUN_NAME : `${CHECK_RUN_NAME} (${directory})`;
}

/** The commit the check belongs to: the head of a pull request (GITHUB_SHA is the merge commit there), else GITHUB_SHA. */
export function checkRunSha(env: NodeJS.ProcessEnv, facts: CheckRunsKnowledge): string | undefined {
  const eventPath = env[facts.variables.eventPath];
  if (eventPath !== undefined && eventPath !== '') {
    try {
      let value: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
      for (const key of facts.pullRequestHeadSha) value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
      if (typeof value === 'string' && /^[0-9a-f]{40,64}$/u.test(value)) return value;
    } catch {
      // No payload or not JSON: the commit of the run.
    }
  }
  const sha = env[facts.variables.sha];
  return sha !== undefined && /^[0-9a-f]{40,64}$/u.test(sha) ? sha : undefined;
}

/** A summary within the API limit, cut at a line with a note when longer. */
export function fitSummary(markdown: string, limit: number): string {
  if (markdown.length <= limit) return markdown;
  const note = '\n\nThe rest did not fit; the job log and the job summary have everything.\n';
  const cut = markdown.slice(0, limit - note.length);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf('\n')))}${note}`;
}

/**
 * Creates the check run; returns a line for the log. The token goes only to the API URL the runner sets, in a header,
 * and is never printed.
 */
export async function createCheckRun(env: NodeJS.ProcessEnv, token: string, content: CheckRunContent, fetchImpl: CheckRunFetch): Promise<string> {
  const facts = values(environment.githubActions.checkRuns)[0];
  if (facts === undefined) return 'depcurfew: the depcurfew doctor check was not added: depcurfew knows no check run API\n';
  const apiUrl = env[facts.variables.apiUrl];
  const repository = env[facts.variables.repository];
  const sha = checkRunSha(env, facts);
  if (apiUrl === undefined || !/^https:\/\//u.test(apiUrl) || repository === undefined || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || sha === undefined) {
    return `depcurfew: the depcurfew doctor check was not added: ${facts.variables.apiUrl}, ${facts.variables.repository} or the commit is not set, as outside GitHub Actions\n`;
  }
  const permission = Object.entries(facts.permission)
    .map(([name, level]) => `${name}: ${level}`)
    .join(', ');
  let response: { status: number };
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/u, '')}${facts.endpoint.replace('{repository}', repository)}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'depcurfew',
        'x-github-api-version': facts.apiVersion,
      },
      body: JSON.stringify({
        name: content.name,
        head_sha: sha,
        status: 'completed',
        conclusion: content.conclusion,
        output: { title: content.title, summary: fitSummary(content.summary, facts.summaryMaxLength) },
      }),
      // A run must not wait long on the API: the result is in the log and the job summary already.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return `depcurfew: the depcurfew doctor check was not added: the GitHub API did not answer (${error instanceof Error ? error.message : String(error)})\n`;
  }
  if (response.status === 201) return `depcurfew: added the check "${content.name}" with the result to the commit ${sha.slice(0, 12)}\n`;
  if (response.status === 403 || response.status === 404) {
    return `depcurfew: the depcurfew doctor check was not added: the workflow token may not create checks (HTTP ${response.status}). Add "${permission}" to the permissions of the job, or set the input check-run to false. A pull request from a fork gets a read-only token.\n`;
  }
  return `depcurfew: the depcurfew doctor check was not added: the GitHub API answered HTTP ${response.status}\n`;
}
