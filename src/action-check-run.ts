// The "depcurfew doctor" check run (decisions D-095 and D-104): the result, every check and the findings as annotations
// on the files, in the Checks tab of a pull request next to the code scanning entry, whose text GitHub writes itself and
// which lists alerts only. Created with the workflow token over the GitHub API that the runner names; an earlier run of
// the action on the same commit with the same name is updated instead, so push and pull_request give one entry. Without
// the checks: write permission the API refuses, and the step only says so in the log. Nothing here fails the step.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { values } from './apply/facts.ts';
import type { CheckRunAnnotation } from './doctor/github.ts';
import { environment } from './knowledge/environment.ts';
import type { CheckRunsKnowledge } from './knowledge/types.ts';

export type { CheckRunAnnotation } from './doctor/github.ts';

export interface CheckRunContent {
  /** "depcurfew doctor", with the directory when it is not the workspace root, so that several runs stay apart. */
  name: string;
  title: string;
  /** Markdown, cut to the limit of the API. */
  summary: string;
  conclusion: 'success' | 'neutral' | 'failure';
  /** Findings on lines of files; sent in requests of at most the number the API takes. */
  annotations?: readonly CheckRunAnnotation[];
}

export type CheckRunFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export const CHECK_RUN_NAME = 'depcurfew doctor';

/**
 * Set on the check runs depcurfew creates, so that a later run on the same commit finds its own entry and no other;
 * followed by a colon and the fingerprint of the annotations of the entry (checkRunExternalId).
 */
export const CHECK_RUN_EXTERNAL_ID = 'depcurfew';

/**
 * The external_id of an entry with these annotations: "depcurfew:" and the SHA-256 of the annotations, so that a later
 * run on the same commit can tell whether the annotations the entry has are the ones it would add (decision D-107).
 */
export function checkRunExternalId(annotations: readonly CheckRunAnnotation[]): string {
  return `${CHECK_RUN_EXTERNAL_ID}:${createHash('sha256').update(JSON.stringify(annotations)).digest('hex')}`;
}

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

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function reason(error: unknown): string {
  return `the GitHub API did not answer (${error instanceof Error ? error.message : String(error)})`;
}

/** An earlier depcurfew entry on the commit with this name, or undefined, also when the API cannot tell. */
interface ExistingRun {
  id: number;
  annotations: number;
  /** Its external_id: CHECK_RUN_EXTERNAL_ID alone (earlier versions of the action) or with the fingerprint. */
  externalId: string;
}

/** The external id of an entry a later run replaced. */
const REPLACED_EXTERNAL_ID = `${CHECK_RUN_EXTERNAL_ID}:replaced`;

function existingRun(answer: unknown, name: string): ExistingRun | undefined {
  const runs = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>)['check_runs'] : undefined;
  if (!Array.isArray(runs)) return undefined;
  for (const run of runs as unknown[]) {
    if (typeof run !== 'object' || run === null) continue;
    const entry = run as Record<string, unknown>;
    const externalId = entry['external_id'];
    if (entry['name'] !== name || typeof externalId !== 'string' || !(externalId === CHECK_RUN_EXTERNAL_ID || externalId.startsWith(`${CHECK_RUN_EXTERNAL_ID}:`))) continue;
    // An entry this action marked as replaced is never the current one again, whatever order the API lists them in.
    if (externalId === REPLACED_EXTERNAL_ID) continue;
    if (typeof entry['id'] !== 'number' || !Number.isSafeInteger(entry['id'])) continue;
    const output = entry['output'];
    const count = typeof output === 'object' && output !== null ? (output as Record<string, unknown>)['annotations_count'] : undefined;
    return { id: entry['id'], annotations: typeof count === 'number' ? count : 0, externalId };
  }
  return undefined;
}

/**
 * Creates the check run, or updates the one an earlier run of the action left on the same commit with the same name;
 * returns one line for the log. The token goes only to the API URL the runner sets, in a header, and is never printed.
 * Looking for the earlier entry and creating one is not atomic: two jobs that run at the same time can still add one
 * entry each. Any failure of the lookup or the update falls back to creating the entry.
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
  const base = apiUrl.replace(/\/+$/u, '');
  const url = (template: string, id?: number) =>
    `${base}${template.replace('{repository}', repository).replace('{ref}', sha).replace('{id}', id === undefined ? '' : String(id))}`;
  const request = (method: string, target: string, body?: unknown) =>
    fetchImpl(target, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'user-agent': 'depcurfew',
        'x-github-api-version': facts.apiVersion,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A run must not wait long on the API: the result is in the log and the job summary already.
      signal: AbortSignal.timeout(15_000),
    });
  const batches: (readonly CheckRunAnnotation[])[] = [];
  const annotations = content.annotations ?? [];
  for (let start = 0; start < annotations.length; start += facts.annotationsPerRequest) batches.push(annotations.slice(start, start + facts.annotationsPerRequest));
  const output = (batch: readonly CheckRunAnnotation[] = []) => ({
    title: content.title,
    summary: fitSummary(content.summary, facts.summaryMaxLength),
    ...(batch.length === 0 ? {} : { annotations: batch }),
  });
  const externalId = checkRunExternalId(annotations);
  const result = { status: 'completed', conclusion: content.conclusion, external_id: externalId };

  // One entry per commit and name: push and pull_request of the same commit, or a re-run, update the earlier one.
  let existing: ExistingRun | undefined;
  try {
    const query = `${facts.query.checkName}=${encodeURIComponent(content.name)}&${facts.query.filter}=${facts.query.latest}`;
    const response = await request('GET', `${url(facts.endpoints.list)}?${query}`);
    if (response.status === 200) existing = existingRun(await response.json(), content.name);
  } catch {
    // Not found out: create the entry, as without the lookup.
  }
  let id: number | undefined;
  let updated = false;
  let pending = batches;
  // Annotations are appended to those of the entry and cannot be removed (decision D-107). An entry without any is
  // updated and gets them; one whose annotations are exactly those of this run (the same fingerprint, all of them added)
  // is updated and keeps them. An entry with other annotations would show findings this run does not have under its
  // result, so a new entry is added and the earlier one says it is replaced.
  let kept = false;
  let replaced: number | undefined;
  if (existing !== undefined) {
    const same = existing.externalId === externalId && existing.annotations === annotations.length;
    if (existing.annotations > 0 && !same) {
      replaced = existing.id;
    } else {
      try {
        const keep = existing.annotations > 0;
        const response = await request('PATCH', url(facts.endpoints.update, existing.id), { ...result, output: output(keep ? [] : batches[0]) });
        if (response.status === 200) {
          ({ id } = existing);
          updated = true;
          kept = keep;
          pending = keep ? [] : batches.slice(1);
        }
      } catch {
        // Create a new entry instead.
      }
    }
  }
  if (!updated) {
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await request('POST', url(facts.endpoints.create), { name: content.name, head_sha: sha, ...result, output: output(batches[0]) });
    } catch (error) {
      return `depcurfew: the depcurfew doctor check was not added: ${reason(error)}\n`;
    }
    if (response.status === 403 || response.status === 404) {
      return `depcurfew: the depcurfew doctor check was not added: the workflow token may not create checks (HTTP ${response.status}). Add "${permission}" to the permissions of the job, or set the input check-run to false. A pull request from a fork gets a read-only token.\n`;
    }
    if (response.status !== 201) return `depcurfew: the depcurfew doctor check was not added: the GitHub API answered HTTP ${response.status}\n`;
    pending = batches.slice(1);
    if (pending.length > 0) {
      try {
        const answer = await response.json();
        const created = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>)['id'] : undefined;
        if (typeof created === 'number' && Number.isSafeInteger(created)) id = created;
      } catch {
        // No id: the further annotations cannot be added.
      }
    }
  }
  // Further annotations: each update appends at most the number one request takes.
  let added = kept ? 0 : (batches[0]?.length ?? 0);
  let failure: string | undefined;
  for (const batch of pending) {
    if (id === undefined) {
      failure = 'the GitHub API did not say which check it added';
      break;
    }
    try {
      const response = await request('PATCH', url(facts.endpoints.update, id), { output: output(batch) });
      if (response.status !== 200) {
        failure = `the GitHub API answered HTTP ${response.status}`;
        break;
      }
    } catch (error) {
      failure = reason(error);
      break;
    }
    added += batch.length;
  }
  // The earlier entry keeps its annotations, but no longer its result: it points to the new one.
  let replacement = '';
  if (replaced !== undefined && !updated) {
    const supersede = {
      conclusion: 'neutral',
      // Kept, so that a later run finds the new entry (the latest of this name) and never this one again.
      external_id: REPLACED_EXTERNAL_ID,
      output: {
        title: 'Replaced by a later run of depcurfew doctor on this commit',
        summary: `A later run of depcurfew doctor on this commit had a different result, and annotations cannot be removed from a check, so its result is in a new "${content.name}" entry. The annotations of this entry are from the earlier run.\n`,
      },
    };
    try {
      const response = await request('PATCH', url(facts.endpoints.update, replaced), supersede);
      replacement = response.status === 200 ? '; the earlier one, whose annotations are out of date, now says it is replaced' : `; the earlier one, whose annotations are out of date, could not be marked as replaced: the GitHub API answered HTTP ${response.status}`;
    } catch (error) {
      replacement = `; the earlier one, whose annotations are out of date, could not be marked as replaced: ${reason(error)}`;
    }
  }
  const commit = sha.slice(0, 12);
  const withAnnotations = added === 0 ? '' : ` and ${plural(added, 'annotation')}`;
  const line = updated
    ? `depcurfew: updated the check "${content.name}" on the commit ${commit} with the result of this run${withAnnotations}, instead of adding a second one${kept ? '; it keeps the annotations it has' : ''}`
    : `depcurfew: added the check "${content.name}" with the result${withAnnotations} to the commit ${commit}${replaced === undefined ? '' : ', next to an earlier one with other annotations'}`;
  const missing = (kept ? 0 : annotations.length) - added;
  return `${line}${failure === undefined || missing === 0 ? '' : `; ${plural(missing, 'more annotation')} could not be added: ${failure}`}${replacement}\n`;
}
