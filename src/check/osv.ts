// --osv: known malicious package versions from OSV.dev (decision D-129). check, the Claude Code hook and depcurfew mcp
// look up the version the install picks; doctor looks up every locked version. One POST to the batch endpoint per
// 1000 versions (the limit of the API), the pages of a paged result followed, and only records of the OpenSSF
// malicious-packages database (ids starting with MAL-) count: other records are vulnerabilities, which npm audit and
// its kind report. Withdrawn records are left out of query answers by OSV.dev, and skipped here should one come. A
// version OSV.dev did not answer for (no network, an error, a redirect, an answer that is too large or not a batch
// result, pages that do not end) stays unchecked with the reason, never clean. A batch result is one OSV.dev sends:
// record ids in the grammar of the OSV schema and no more records in one result than two of its pages (decision
// D-135), and a redirect is named by the origin of its location, or as a location that is not a URL (decision D-142),
// so no other text of an answer reaches a message. Only the name, the ecosystem and the version are sent, and
// nothing at all without --osv.
import { isRecord, values } from '../apply/facts.ts';
import { osv as facts } from '../knowledge/osv.ts';
import type { OsvApiKnowledge } from '../knowledge/types.ts';
import { ecosystemOf, prefixOf } from '../policy/package-pattern.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import type { CheckFinding, PackageReport } from './findings.ts';
import { cachedLookup, readLimited, requestSignal, type FetchLike, type LookupCache } from './registry.ts';

/** A package version to look up; `ecosystem` is depcurfew's (npm, pypi, packagist), whose names the policy writes without a prefix, with pypi: and with composer:. */
export interface OsvPackage {
  ecosystem: string;
  name: string;
  version: string;
}

/**
 * Where an answer about known malicious versions comes from: api.osv.dev (--osv), or the local copy of the OSV.dev data
 * that depcurfew osv update writes (decision D-150).
 */
export type OsvSource = 'osv-api' | 'osv-local';

/**
 * What OSV.dev says about one version: the ids of its MAL- records (none: no known malware), or why it was not checked.
 * `source`: where the answer comes from; api.osv.dev when left out.
 */
export type OsvVerdict = { status: 'checked'; malicious: string[]; source?: OsvSource } | { status: 'unchecked'; reason: string };

/** The local copy of the OSV.dev data (LocalOsvData of src/osv/data.ts): the MAL- ids for a version, undefined without data for its ecosystem. */
export interface OsvLocalLookup {
  lookup(pkg: OsvPackage): string[] | undefined;
}

export interface OsvOptions {
  fetch: FetchLike;
  signal?: AbortSignal | undefined;
  /** Per request; OSV_TIMEOUT_MS when left out. */
  timeoutMs?: number;
  /** Largest answer read; the response limit of OSV.dev over HTTP/1.1 when left out. */
  maxBytes?: number;
  /** Most distinct versions looked up in one run; the others stay unchecked. MAX_OSV_PACKAGES when left out. */
  limit?: number;
}

/**
 * Most distinct package versions one run asks about: 20 batch requests. A lockfile of a large monorepo locks a few
 * thousand; more is a repository built to keep doctor waiting, and the rest is reported as not checked.
 */
export const MAX_OSV_PACKAGES = 20_000;
/** Most requests for the pages of one batch; OSV.dev pages a query only past 1000 records, or a batch past 3000. */
export const MAX_OSV_PAGES = 10;
/** Time for one batch request: OSV.dev aims at 6 s for 95% of them, and a paged query may take 20 s before it pages. */
export const OSV_TIMEOUT_MS = 30_000;
/**
 * Longest record id in an answer: real ids are short (MAL-2026-18458, GHSA-xxjr-mmjv-4gpg); a longer one is not an
 * answer of OSV.dev (decision D-135). The schema sets no length.
 */
const MAX_ID_LENGTH = 100;
/** Most records named in one message. */
const MAX_IDS_SHOWN = 5;

/** What to do when OSV.dev did not answer, for a person at the command line. */
export const OSV_RETRY_FIX = 'Run depcurfew check again when api.osv.dev can be reached; --osv needs HTTPS access to it';

function api(): OsvApiKnowledge {
  const fact = values(facts.api)[0];
  if (fact === undefined) throw new Error('the knowledge base has no OSV.dev API fact');
  return fact;
}

/** The URL of the batch query endpoint. */
export function osvBatchUrl(): string {
  return `${api().url}${api().queryBatchPath}`;
}

/** The host depcurfew sends the queries to, for messages. */
export function osvHost(): string {
  return new URL(api().url).host;
}

/** The page of a record on osv.dev. */
export function osvRecordPage(id: string): string {
  return api().recordPage.replace('{id}', encodeURIComponent(id));
}

/** The name OSV.dev gives an ecosystem of depcurfew, or undefined when the knowledge base has none. */
export function osvEcosystem(ecosystem: string): string | undefined {
  const names = values(facts.ecosystems)[0] ?? {};
  return Object.hasOwn(names, ecosystem) ? names[ecosystem] : undefined;
}

function malwarePrefix(): string {
  return values(facts.malicious)[0]?.idPrefix ?? 'MAL-';
}

function withdrawnField(): string {
  return values(facts.withdrawn)[0]?.field ?? 'withdrawn';
}

/** The characters of a record id, from the OSV schema (ids). */
function idPattern(): RegExp {
  return new RegExp(values(facts.ids)[0]?.pattern ?? '^[a-zA-Z0-9:_.-]+$', 'u');
}

/**
 * Most records one result may list: OSV.dev pages a query past `perQuery` records (1000), a number that "can vary
 * slightly", so a result with more than twice that is not one it sends (decision D-135). This also bounds the records
 * of one version: MAX_OSV_PAGES pages of them.
 */
function maxRecordsPerResult(): number {
  return 2 * (values(facts.paging)[0]?.perQuery ?? 1000);
}

/** Two spellings of one Python name are one package (PEP 503), as OSV.dev matches them. */
function comparedName(pkg: OsvPackage): string {
  return pkg.ecosystem === 'pypi' ? normalizePythonName(pkg.name) : pkg.name;
}

/** One key per package version, for the cache and for the answers of doctor. */
export function osvKey(pkg: OsvPackage): string {
  return `${pkg.ecosystem}\u0000${comparedName(pkg)}\u0000${pkg.version}`;
}

interface Query {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

/** Why a batch request failed, or its results (one per query, in their order). */
type BatchAnswer = { results: { ids: string[]; token: string | undefined }[] } | { reason: string };

const NOT_A_BATCH = 'something that is not a batch result';

/** What one read result is checked against, read from the knowledge base once per answer. */
interface ResultRules {
  fields: OsvApiKnowledge;
  pattern: RegExp;
  prefix: string;
  withdrawn: string;
  most: number;
}

/**
 * The MAL- ids of one result (each once) and its page token, or undefined when the result is not one OSV.dev sends:
 * more records than two pages hold, a record without an id, or an id outside the grammar of the OSV schema.
 */
function readResult(result: unknown, rules: ResultRules): { ids: string[]; token: string | undefined } | undefined {
  const { fields } = rules;
  if (!isRecord(result)) return undefined;
  const vulns = result[fields.vulnsField] ?? [];
  if (!Array.isArray(vulns) || vulns.length > rules.most) return undefined;
  const ids = new Set<string>();
  for (const vuln of vulns) {
    if (!isRecord(vuln)) return undefined;
    const id = vuln[fields.idField];
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !rules.pattern.test(id)) return undefined;
    // OSV.dev leaves withdrawn records out of query answers; one that comes anyway is not reported.
    if (vuln[rules.withdrawn] !== undefined && vuln[rules.withdrawn] !== null) continue;
    if (id.startsWith(rules.prefix)) ids.add(id);
  }
  const token = result[fields.nextPageTokenField];
  return { ids: [...ids], token: typeof token === 'string' && token !== '' ? token : undefined };
}

async function postBatch(queries: readonly Query[], options: OsvOptions): Promise<BatchAnswer> {
  const fields = api();
  const host = osvHost();
  let response: Response;
  try {
    response = await options.fetch(osvBatchUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ [fields.queriesField]: queries }),
      // A redirect is not followed: the answer must come from OSV.dev itself.
      redirect: 'manual',
      signal: requestSignal(options.timeoutMs ?? OSV_TIMEOUT_MS, options.signal),
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { reason: timedOut ? `${host} did not answer in time` : `${host} cannot be reached (${error instanceof Error ? error.message : String(error)})` };
  }
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    await response.body?.cancel();
    let origin: string | undefined;
    try {
      origin = new URL(location, osvBatchUrl()).origin;
    } catch {
      // A location that is not a URL is the text of the answer, which never reaches a message (decision D-142).
    }
    return { reason: `${host} redirected to ${origin ?? 'a location that is not a URL'}, which depcurfew does not follow` };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { reason: `${host} answered HTTP ${response.status}` };
  }
  const limit = options.maxBytes ?? values(facts.service)[0]?.responseLimitBytes ?? 32 * 1024 * 1024;
  let document: unknown;
  try {
    document = JSON.parse(await readLimited(response, limit)) as unknown;
  } catch (error) {
    // The time limit and the caller's signal cover reading the answer too.
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (error instanceof Error && error.name === 'TimeoutError') return { reason: `${host} did not answer in time` };
    if (error instanceof Error && error.message.startsWith('the document is larger than')) return { reason: `the answer of ${host} is larger than ${limit / (1024 * 1024)} MiB` };
    return { reason: `${host} answered ${NOT_A_BATCH}` };
  }
  const results = isRecord(document) ? document[fields.resultsField] : undefined;
  if (!Array.isArray(results) || results.length !== queries.length) return { reason: `${host} answered ${NOT_A_BATCH}` };
  const rules: ResultRules = { fields, pattern: idPattern(), prefix: malwarePrefix(), withdrawn: withdrawnField(), most: maxRecordsPerResult() };
  const read: { ids: string[]; token: string | undefined }[] = [];
  for (const result of results) {
    const entry = readResult(result, rules);
    if (entry === undefined) return { reason: `${host} answered ${NOT_A_BATCH}` };
    read.push(entry);
  }
  return { results: read };
}

/**
 * One batch of at most maxQueriesPerBatch versions, with its pages: the queries that came back with a token are sent
 * again with it, until none has one. When the first request fails, the reason alone, so that the caller stops.
 */
async function lookUpBatch(batch: readonly Query[], options: OsvOptions): Promise<OsvVerdict[] | { reason: string }> {
  const fields = api();
  // The ids of each version, each once across its pages (a Set: thousands of ids per page stay linear).
  const found: Set<string>[] = batch.map(() => new Set());
  const checked = (): OsvVerdict[] => found.map((ids) => ({ status: 'checked', malicious: [...ids] }));
  let pending = batch.map((query, index) => ({ index, query }));
  for (let page = 0; pending.length > 0; page++) {
    if (page >= MAX_OSV_PAGES) {
      const verdicts = checked();
      for (const { index } of pending) verdicts[index] = { status: 'unchecked', reason: `OSV.dev answered more than ${MAX_OSV_PAGES} pages for it` };
      return verdicts;
    }
    const answer = await postBatch(
      pending.map(({ query }) => query),
      options,
    );
    if ('reason' in answer) {
      if (page === 0) return answer;
      // A later page failed: the versions still waiting for it are not checked; the others are.
      const verdicts = checked();
      for (const { index } of pending) verdicts[index] = { status: 'unchecked', reason: answer.reason };
      return verdicts;
    }
    const next: typeof pending = [];
    answer.results.forEach((result, position) => {
      const entry = pending[position] as (typeof pending)[number];
      const ids = found[entry.index];
      for (const id of result.ids) ids?.add(id);
      if (result.token !== undefined) next.push({ index: entry.index, query: { ...batch[entry.index], [fields.pageTokenField]: result.token } as Query });
    });
    pending = next;
  }
  return checked();
}

/**
 * What OSV.dev says about each package version, in the order given. Each distinct version is asked about once; the
 * batches go one after the other, and once one fails the rest is not asked (OSV.dev is out of reach, or answers
 * wrong), so every version left is unchecked with that reason. When `options.signal` aborts, the promise rejects.
 */
export async function queryOsv(packages: readonly OsvPackage[], options: OsvOptions): Promise<OsvVerdict[]> {
  const limit = options.limit ?? MAX_OSV_PACKAGES;
  const verdicts = new Map<string, OsvVerdict>();
  const distinct: { key: string; query: Query }[] = [];
  const queued = new Set<string>();
  for (const pkg of packages) {
    const key = osvKey(pkg);
    if (verdicts.has(key) || queued.has(key)) continue;
    const ecosystem = osvEcosystem(pkg.ecosystem);
    if (ecosystem === undefined) {
      verdicts.set(key, { status: 'unchecked', reason: `depcurfew does not know the name OSV.dev gives the ecosystem ${pkg.ecosystem}` });
      continue;
    }
    if (distinct.length >= limit) {
      verdicts.set(key, { status: 'unchecked', reason: `there are more than ${limit} package versions to check, and depcurfew asks OSV.dev about at most ${limit} in one run` });
      continue;
    }
    queued.add(key);
    distinct.push({ key, query: { package: { name: pkg.name, ecosystem }, version: pkg.version } });
  }
  const size = Math.max(1, api().maxQueriesPerBatch);
  let failed: string | undefined;
  for (let start = 0; start < distinct.length; start += size) {
    const batch = distinct.slice(start, start + size);
    const answer = failed === undefined ? await lookUpBatch(batch.map((entry) => entry.query), options) : { reason: failed };
    if ('reason' in answer) {
      failed = answer.reason;
      for (const entry of batch) verdicts.set(entry.key, { status: 'unchecked', reason: answer.reason });
      continue;
    }
    batch.forEach((entry, index) => verdicts.set(entry.key, answer[index] as OsvVerdict));
  }
  return packages.map((pkg) => verdicts.get(osvKey(pkg)) as OsvVerdict);
}

/** The ids of the records with their pages: MAL-2026-1 (https://osv.dev/vulnerability/MAL-2026-1), …, at most five. */
export function linkedIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_IDS_SHOWN).map((id) => `${id} (${osvRecordPage(id)})`);
  const more = ids.length - MAX_IDS_SHOWN;
  return more > 0 ? `${shown.join(', ')} and ${more} more ${more === 1 ? 'record' : 'records'}` : shown.join(', ');
}

/**
 * How a version of a package is written in a message: name@1.2.3, for Python name==1.2.3 as pip takes it, and for
 * Composer vendor/name:1.2.3 as composer require takes it, where @ is a stability flag (decisions D-133 and D-142).
 */
export function versionLabel(ecosystem: string, name: string, version: string): string {
  return `${name}${ecosystem === 'pypi' ? '==' : ecosystem === 'packagist' ? ':' : '@'}${version}`;
}

/** The ecosystem of a checked package name and the name OSV.dev knows: the policy prefix (pypi:, composer:) is left out. */
function packageOf(report: PackageReport): OsvPackage | undefined {
  if (report.kind !== 'registry' || report.name === undefined || report.version === undefined) return undefined;
  const ecosystem = ecosystemOf(report.name);
  return { ecosystem, name: report.name.slice(prefixOf(ecosystem).length), version: report.version };
}

/**
 * The answer of the local data where api.osv.dev gave none (decision D-150): a version the local data lists as
 * malicious is reported from it; one it does not list stays unchecked, since --osv asked for the answer of the API.
 */
export function withLocalAnswer(pkg: OsvPackage, verdict: OsvVerdict, local: OsvLocalLookup | undefined): OsvVerdict {
  if (verdict.status === 'checked' || local === undefined) return verdict;
  const ids = local.lookup(pkg);
  return ids !== undefined && ids.length > 0 ? { status: 'checked', malicious: ids, source: 'osv-local' } : verdict;
}

/**
 * Looks up the version each report picked and adds what OSV.dev says: a MAL- record is an error (known-malicious, first
 * among the findings), a version OSV.dev did not answer for is unverified, unless the local data (`local`) lists it as
 * malicious. Versions are looked up once per run, also across the checks of one hook command (`lookups`).
 */
export async function addOsvFindings(reports: readonly PackageReport[], options: OsvOptions & { lookups?: LookupCache | undefined; local?: OsvLocalLookup | undefined }): Promise<void> {
  const wanted = reports.map((report) => ({ report, pkg: packageOf(report) })).filter((entry): entry is { report: PackageReport; pkg: OsvPackage } => entry.pkg !== undefined);
  if (wanted.length === 0) return;
  const cacheKey = (pkg: OsvPackage) => `osv\u0000${osvKey(pkg)}`;
  const missing = wanted.filter(({ pkg }) => options.lookups?.has(cacheKey(pkg)) !== true).map(({ pkg }) => pkg);
  const batch = missing.length === 0 ? Promise.resolve([]) : queryOsv(missing, options);
  const position = new Map(missing.map((pkg, index) => [osvKey(pkg), index] as const).reverse());
  const verdicts = await Promise.all(wanted.map(({ pkg }) => cachedLookup(options.lookups, cacheKey(pkg), async () => (await batch)[position.get(osvKey(pkg)) ?? -1] as OsvVerdict)));
  wanted.forEach(({ report, pkg }, index) => {
    const verdict = withLocalAnswer(pkg, verdicts[index] as OsvVerdict, options.local);
    const finding = osvFinding(report.name ?? pkg.name, pkg, verdict);
    if (finding !== undefined) report.findings.unshift(finding);
  });
}

/**
 * Without --osv: looks the version each report picked up in the local data (decision D-150), with no network access,
 * and adds known-malicious for a version it lists. A version of an ecosystem without local data is not looked up.
 */
export function addLocalOsvFindings(reports: readonly PackageReport[], local: OsvLocalLookup): void {
  for (const report of reports) {
    const pkg = packageOf(report);
    if (pkg === undefined) continue;
    const ids = local.lookup(pkg);
    if (ids === undefined || ids.length === 0) continue;
    const finding = osvFinding(report.name ?? pkg.name, pkg, { status: 'checked', malicious: ids, source: 'osv-local' });
    if (finding !== undefined) report.findings.unshift(finding);
  }
}

/** The ecosystems of the versions a check looked up (registry packages with a version), for the notes about the local data. */
export function checkedEcosystems(reports: readonly PackageReport[]): string[] {
  return [...new Set(reports.flatMap((report) => packageOf(report)?.ecosystem ?? []))];
}

/** The finding of one checked version: known-malicious for MAL- records, unverified when OSV.dev did not answer. */
function osvFinding(name: string, pkg: OsvPackage, verdict: OsvVerdict): CheckFinding | undefined {
  if (verdict.status === 'unchecked') {
    return { level: 'error', code: 'unverified', message: `it was not checked for known malicious versions in OSV.dev: ${verdict.reason}`, fix: OSV_RETRY_FIX };
  }
  if (verdict.malicious.length === 0) return undefined;
  return maliciousFinding(name, pkg, verdict.malicious, verdict.source ?? 'osv-api');
}

/**
 * known-malicious for a version with MAL- records (`ids`); `name` is the name of the report (with pypi: or composer:),
 * and `source` says where the answer comes from: api.osv.dev or the local data of depcurfew osv update (decision D-150).
 */
export function maliciousFinding(name: string, pkg: OsvPackage, ids: readonly string[], source: OsvSource): CheckFinding {
  return {
    level: 'error',
    code: 'known-malicious',
    // A Composer version as composer require takes it (composer:vendor/name:1.2.3), as the other findings of check write it.
    message: `${versionLabel(pkg.ecosystem, name, pkg.version)} is a known malicious version: OSV.dev lists it as ${linkedIds(ids)}`,
    fix: 'Do not install it; pick another package or version. If it is installed anywhere already, remove it and read the record on OSV.dev for what it does',
    source,
  };
}
