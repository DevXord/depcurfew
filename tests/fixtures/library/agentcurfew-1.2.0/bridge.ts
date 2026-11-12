// A mirror of the part of agentcurfew 1.2.0 that calls depcurfew's library: src/depcurfew/bridge.ts of
// DevXord/agentcurfew at the tag v1.2.0 (commit 3d06fd56d651556c3108921778d01c6aee42a857), whose package.json allows
// depcurfew ">=1.5.2 <2". Every line that touches depcurfew is copied as it is; the walk over agentcurfew's inventory of
// MCP servers is replaced by a list of specs (checkPackages instead of checkMcpPackages), and depcurfewSpec and
// checkableServers, which do not touch depcurfew, are left out.
//
// tests/library/agentcurfew-bridge-e02.test.ts compiles this file against dist/index.d.ts as the module 'depcurfew'
// with agentcurfew's strict compiler options, and runs it against dist/index.js. A change of depcurfew that would break
// agentcurfew 1.2.0 (a renamed export, a new required option, a finding level other than error and warning) fails there.
// This file is not part of npm run typecheck (tsconfig.json leaves tests/fixtures out), since it needs the build.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Depcurfew = typeof import('depcurfew');

/** The versions of depcurfew whose public API this bridge was written against (D-028). */
export const SUPPORTED_RANGE = '>=1.5.2 <2';

/**
 * depcurfew's findings that need no network: the policy's forbidden sources and specs that are not specs. Every other
 * code (unverified, not-found, too-young, install scripts, similar names, known malicious versions) needs the registry
 * or data agentcurfew does not read, so it is never reported here (D-028).
 */
export const OFFLINE_CODES: ReadonlySet<string> = new Set(['forbidden-source', 'invalid-spec', 'unchecked-source', 'insecure-registry']);

export interface PackageFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  fix: string;
}

export interface PackageReport {
  spec: string;
  findings: PackageFinding[];
}

export type DepcurfewState = { status: 'missing' | 'unsupported' | 'no-policy' | 'invalid-policy'; reason: string } | { status: 'ready'; version: string };

let loader: () => Promise<Depcurfew | undefined> = async () => {
  try {
    return (await import('depcurfew')) as Depcurfew;
  } catch {
    return undefined;
  }
};

/** For tests: how depcurfew is loaded, so that a run without it can be simulated. */
export function setDepcurfewLoader(load: () => Promise<Depcurfew | undefined>): void {
  loader = load;
  cached = undefined;
}

let cached: Promise<Depcurfew | undefined> | undefined;

function supported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major === 1 && (minor > 5 || (minor === 5 && patch >= 2));
}

/** A fetch that refuses every request: agentcurfew never uses the network, so depcurfew gets no answer from a registry. */
const offline = async (): Promise<Response> => {
  throw new Error('agentcurfew does not use the network');
};

/** checkMcpPackages of agentcurfew 1.2.0, with the specs given instead of read from the inventory. */
export async function checkPackages(specs: readonly string[], root: string, now: Date = new Date()): Promise<{ state: DepcurfewState; reports: Map<string, PackageReport> }> {
  const reports = new Map<string, PackageReport>();
  cached ??= loader();
  const depcurfew = await cached;
  if (depcurfew === undefined) return { state: { status: 'missing', reason: 'depcurfew is not installed' }, reports };
  const version = depcurfew.getVersion();
  if (!supported(version)) return { state: { status: 'unsupported', reason: `depcurfew ${version} is outside ${SUPPORTED_RANGE}` }, reports };
  if (!existsSync(join(root, 'depcurfew.json'))) return { state: { status: 'no-policy', reason: 'the project has no depcurfew.json' }, reports };
  let policy: ReturnType<Depcurfew['loadPolicy']>;
  try {
    policy = depcurfew.loadPolicy(root);
  } catch {
    return { state: { status: 'invalid-policy', reason: 'depcurfew.json cannot be read by depcurfew' }, reports };
  }
  const wanted: { key: string; spec: string }[] = specs.map((spec, index) => ({ key: `${index}\0${spec}`, spec }));
  if (wanted.length === 0) return { state: { status: 'ready', version }, reports };
  const results = await depcurfew.checkSpecs(
    wanted.map((item) => item.spec),
    { policy, fetch: offline, now, registry: 'https://registry.npmjs.org/', popular: new depcurfew.PopularNames([]) },
  );
  results.forEach((report, index) => {
    const item = wanted[index];
    if (item === undefined) return;
    const findings = report.findings.filter((finding) => OFFLINE_CODES.has(finding.code)).map(({ level, code, message, fix }) => ({ level, code, message, fix }));
    reports.set(item.key, { spec: item.spec, findings });
  });
  return { state: { status: 'ready', version }, reports };
}
