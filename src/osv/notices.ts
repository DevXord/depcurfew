// What check, the Claude Code hook and depcurfew mcp say about the local OSV.dev data they looked versions up in
// (decision D-150): data older than OSV_DATA_NOTE_DAYS gives a note, older than OSV_DATA_WARNING_DAYS a warning, and
// data that cannot be read a note, each with what to do. Data that is missing gives nothing: without depcurfew osv
// update nothing changes for check. Data in a directory other users can write gives a warning (decision D-156).
import { osvEcosystem } from '../check/osv.ts';
import type { CacheWriteProblem } from '../user/cache-path.ts';
import { dataAgeDays, dataDate, dataStaleness, type LocalOsvData } from './data.ts';

export interface OsvDataNotice {
  level: 'note' | 'warning';
  code: 'osv-data-old' | 'osv-data-unreadable' | 'osv-cache-shared';
  /** The file of the local data. */
  file: string;
  message: string;
  fix: string;
}

/** What to do about old local data: for a person, and for an agent, who tells the user. */
export const OSV_UPDATE_FIX = 'Run depcurfew osv update to download the current data';
const AGENT_UPDATE_FIX = 'Tell the user that the local OSV.dev data is old; they update it with depcurfew osv update';
const REWRITE_FIX = 'Run depcurfew osv update to write it again';
const AGENT_REWRITE_FIX = 'Tell the user that the local OSV.dev data cannot be read; depcurfew osv update writes it again';

/** Which directory other users can write, and how: for messages (decision D-156). */
export function writeProblemReason(problem: CacheWriteProblem): string {
  if (problem.kind === 'owner') return `${problem.directory} belongs to another user (uid ${problem.id ?? '?'})`;
  if (problem.kind === 'group') return `${problem.directory} can be written by the members of its group (gid ${problem.id ?? '?'})`;
  return `${problem.directory} can be written by every user`;
}

/** What a data directory other users can write means, as osv update and the lookups say it. */
export function writeProblemMessage(problem: CacheWriteProblem): string {
  return `other users may change the local OSV.dev data, so a malicious version may pass: ${writeProblemReason(problem)}`;
}

/**
 * What to do about it: take the write access away where the directory is the user's own, else (and always as the other
 * way) keep the data in a directory only the user can write; then write the data again, followed by `then`.
 */
export function writeProblemFix(problem: CacheWriteProblem, then = 'depcurfew osv update'): string {
  const away = problem.own ? `Remove the write access of other users with chmod go-w ${problem.directory} or set` : 'Set';
  return `${away} XDG_CACHE_HOME to a directory only you can write, then run ${then}`;
}

/** The notices about the local data of the ecosystems a check looked versions up in. */
export function localDataNotices(local: LocalOsvData, ecosystems: readonly string[], now: Date, audience: 'person' | 'agent' = 'person'): OsvDataNotice[] {
  const notices: OsvDataNotice[] = [];
  const agent = audience === 'agent';
  for (const ecosystem of ecosystems) {
    const state = local.state(ecosystem);
    const name = osvEcosystem(ecosystem) ?? ecosystem;
    if (state.status === 'unreadable') {
      notices.push({
        level: 'note',
        code: 'osv-data-unreadable',
        file: state.file,
        message: `the local OSV.dev data for ${name} (${state.file}) cannot be read: ${state.reason}; the versions were not looked up in it`,
        fix: agent ? AGENT_REWRITE_FIX : REWRITE_FIX,
      });
      continue;
    }
    if (state.status !== 'ready') continue;
    const staleness = dataStaleness(state, now);
    if (staleness === 'fresh') continue;
    const days = dataAgeDays(state, now);
    notices.push({
      level: staleness,
      code: 'osv-data-old',
      file: state.file,
      message: `the local OSV.dev data for ${name} is from ${dataDate(state)}, ${days} ${days === 1 ? 'day' : 'days'} old: malicious versions reported since then are not in it`,
      fix: agent ? AGENT_UPDATE_FIX : OSV_UPDATE_FIX,
    });
  }
  // Only when versions were looked up in the data; the lookups use it all the same.
  const problem = local.directory !== undefined && ecosystems.some((ecosystem) => local.state(ecosystem).status === 'ready') ? local.writeProblem() : undefined;
  if (problem !== undefined && local.directory !== undefined) {
    notices.push({
      level: 'warning',
      code: 'osv-cache-shared',
      file: problem.directory,
      message: `${writeProblemMessage(problem)}; the versions were looked up in it all the same`,
      // Short for the context of the hook; depcurfew osv update gives the whole fix.
      fix: agent ? `Tell the user that other users may change the local OSV.dev data in ${problem.directory}; depcurfew osv update says how to fix it` : writeProblemFix(problem),
    });
  }
  return notices;
}
