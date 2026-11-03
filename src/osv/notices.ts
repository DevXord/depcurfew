// What check, the Claude Code hook and depcurfew mcp say about the local OSV.dev data they looked versions up in
// (decision D-150): data older than OSV_DATA_NOTE_DAYS gives a note, older than OSV_DATA_WARNING_DAYS a warning, and
// data that cannot be read a note, each with what to do. Data that is missing gives nothing: without depcurfew osv
// update nothing changes for check.
import { osvEcosystem } from '../check/osv.ts';
import { dataAgeDays, dataDate, dataStaleness, type LocalOsvData } from './data.ts';

export interface OsvDataNotice {
  level: 'note' | 'warning';
  code: 'osv-data-old' | 'osv-data-unreadable';
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
  return notices;
}
