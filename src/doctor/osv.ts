// doctor --osv (decision D-129). The rules are synchronous and read the repository only, so the lookup happens between
// two runs: the first runs known-malicious alone to collect the locked versions, OSV.dev is asked about all of them in
// batch queries, and the second run is the normal one, in which known-malicious reports from the answers. Both runs
// read the same files the same way, the projects of depcurfew.json included.
import { osvKey, queryOsv, type OsvOptions, type OsvPackage, type OsvVerdict } from '../check/osv.ts';
import { runDoctor } from './index.ts';
import { knownMalicious } from './rules/known-malicious.ts';
import type { DoctorReport, OsvDoctor } from './types.ts';

/** The locked versions of the repository at `root`, as known-malicious reads them. */
export function lockedVersions(root: string, options: Omit<Parameters<typeof runDoctor>[1] & object, 'rules' | 'osv'> = {}): OsvPackage[] {
  const collect: OsvPackage[] = [];
  runDoctor(root, { ...options, rules: [knownMalicious], osv: { collect } });
  return collect;
}

/** The answers of OSV.dev for `packages`, by osvKey, as the second run of doctor takes them. */
export async function osvAnswers(packages: readonly OsvPackage[], options: OsvOptions): Promise<OsvDoctor> {
  const verdicts = await queryOsv(packages, options);
  const answers = new Map<string, OsvVerdict>();
  packages.forEach((pkg, index) => answers.set(osvKey(pkg), verdicts[index] as OsvVerdict));
  return { answers };
}

/**
 * runDoctor with known-malicious: the locked versions are looked up in OSV.dev first. Throws PolicyError as runDoctor
 * does for an invalid depcurfew.json, unless asked to report it.
 */
export async function runDoctorWithOsv(root: string, options: Omit<Parameters<typeof runDoctor>[1] & object, 'osv'>, osv: OsvOptions): Promise<DoctorReport> {
  const { rules: _rules, ...reading } = options;
  const answers = await osvAnswers(lockedVersions(root, reading), osv);
  return runDoctor(root, { ...options, osv: answers });
}
