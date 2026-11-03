// doctor --osv (decision D-129) and doctor with the local OSV.dev data of depcurfew osv update (decision D-150). The
// rules are synchronous and read the repository only, so the lookup happens between two runs: the first runs
// known-malicious alone to collect the locked versions, they are looked up (in OSV.dev in batch queries, or in the
// local data without network access), and the second run is the normal one, in which known-malicious reports from the
// answers. Both runs read the same files the same way, the projects of depcurfew.json included.
import { osvKey, queryOsv, withLocalAnswer, type OsvLocalLookup, type OsvOptions, type OsvPackage, type OsvVerdict } from '../check/osv.ts';
import { dataAgeDays, dataDate, dataStaleness, OSV_DATA_ECOSYSTEMS, type LocalOsvData } from '../osv/data.ts';
import { writeProblemFix, writeProblemReason } from '../osv/notices.ts';
import { runDoctor } from './index.ts';
import { knownMalicious } from './rules/known-malicious.ts';
import type { DoctorReport, OsvDoctor, OsvLocalDoctor, OsvLocalEcosystem } from './types.ts';

/** The locked versions of the repository at `root`, as known-malicious reads them. */
export function lockedVersions(root: string, options: Omit<Parameters<typeof runDoctor>[1] & object, 'rules' | 'osv'> = {}): OsvPackage[] {
  const collect: OsvPackage[] = [];
  runDoctor(root, { ...options, rules: [knownMalicious], osv: { collect } });
  return collect;
}

/**
 * The answers of OSV.dev for `packages`, by osvKey, as the second run of doctor takes them. A version OSV.dev did not
 * answer for is answered by the local data (`local`) when that lists it as malicious.
 */
export async function osvAnswers(packages: readonly OsvPackage[], options: OsvOptions & { local?: OsvLocalLookup | undefined }): Promise<OsvDoctor> {
  const verdicts = await queryOsv(packages, options);
  const answers = new Map<string, OsvVerdict>();
  packages.forEach((pkg, index) => answers.set(osvKey(pkg), withLocalAnswer(pkg, verdicts[index] as OsvVerdict, options.local)));
  return { answers };
}

/**
 * runDoctor with known-malicious: the locked versions are looked up in OSV.dev first. Throws PolicyError as runDoctor
 * does for an invalid depcurfew.json, unless asked to report it.
 */
export async function runDoctorWithOsv(root: string, options: Omit<Parameters<typeof runDoctor>[1] & object, 'osv'>, osv: OsvOptions & { local?: OsvLocalLookup | undefined }): Promise<DoctorReport> {
  const { rules: _rules, ...reading } = options;
  const answers = await osvAnswers(lockedVersions(root, reading), osv);
  return runDoctor(root, { ...options, osv: answers });
}

/** What known-malicious says about the local data of each ecosystem, on `now`. */
export function localDoctorState(local: LocalOsvData, now: Date): OsvLocalDoctor {
  const ecosystems: Record<string, OsvLocalEcosystem> = {};
  for (const ecosystem of OSV_DATA_ECOSYSTEMS) {
    const state = local.state(ecosystem);
    ecosystems[ecosystem] =
      state.status === 'ready'
        ? { status: 'ready', date: dataDate(state), days: dataAgeDays(state, now), staleness: dataStaleness(state, now) }
        : state.status === 'unreadable'
          ? { status: 'unreadable', reason: state.reason }
          : { status: 'missing' };
  }
  const problem = local.writeProblem();
  if (problem === undefined) return { ecosystems };
  return { ecosystems, shared: { reason: writeProblemReason(problem), fix: writeProblemFix(problem, 'depcurfew osv update and depcurfew doctor again') } };
}

/**
 * The answers of the local data for the locked versions, by osvKey: the MAL- records it lists for each version of an
 * ecosystem with readable data, with the state of the data of each ecosystem.
 */
export function localAnswers(packages: readonly OsvPackage[], local: LocalOsvData, now: Date): OsvDoctor {
  const answers = new Map<string, OsvVerdict>();
  for (const pkg of packages) {
    const ids = local.lookup(pkg);
    if (ids !== undefined) answers.set(osvKey(pkg), { status: 'checked', malicious: ids, source: 'osv-local' });
  }
  // After the lookups: a line that cannot be read makes the data of its ecosystem unreadable.
  return { answers, local: localDoctorState(local, now) };
}

/**
 * runDoctor without --osv: with the local OSV.dev data when any exists, else with the note that says how to get it
 * (decision D-150). Nothing leaves the machine.
 */
export function runDoctorWithLocalOsv(root: string, options: Omit<Parameters<typeof runDoctor>[1] & object, 'osv'>, local: LocalOsvData, now: Date): DoctorReport {
  if (!local.any()) return runDoctor(root, { ...options, osv: { unavailable: true } });
  const { rules: _rules, ...reading } = options;
  return runDoctor(root, { ...options, osv: localAnswers(lockedVersions(root, reading), local, now) });
}
