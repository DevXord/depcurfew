// Records registry responses for the tests of depcurfew check, which run without network access: npm package documents
// in tests/fixtures/registry/ and Python index pages in tests/fixtures/pypi/. Each npm document is cut down to what
// check reads: dist-tags, the publish times and, for the kept versions, scripts and deprecated. Each index page keeps
// its versions and status and, for the kept versions, the name, upload time and yanked state of each file. A name the
// registry or index does not know is recorded as a 404. With osv it also sends the queries of
// tests/fixtures/osv/querybatch.json to the batch endpoint of OSV.dev (one POST, read-only) and writes the answer next
// to them, for the tests of --osv (decision D-129). With packagist it records the Packagist.org metadata of Composer
// packages in tests/fixtures/packagist/ (decision D-133): each list of versions is expanded, cut down to the newest
// versions and those the script names, with only the fields check reads, and minified again in Packagist's format.
// Every request to Packagist is a read-only GET to repo.packagist.org whose User-Agent is depcurfew-record: nothing
// that identifies a person. A request that fails stops the script before anything is written.
// Run by hand with network access: npm run record:registry (npm, PyPI, Packagist and OSV.dev), or -- npm, -- pypi,
// -- packagist or -- osv for one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { values } from '../src/apply/facts.ts';
import { defaultRegistry, packumentUrl } from '../src/check/registry.ts';
import { environment } from '../src/knowledge/environment.ts';
import { defaultIndex, fileVersion, projectUrl } from '../src/check/pypi.ts';
import { normalizePythonName } from '../src/policy/python-names.ts';
import { osvBatchUrl } from '../src/check/osv.ts';
import { expandVersions, metadataUrl, packagistApi, packagistUrl } from '../src/check/packagist.ts';

/** name, or name@version to keep that version besides the newest ones. */
const PACKAGES = ['lodash', 'esbuild', 'request', '@types/node', 'cross-env', 'crossenv', 'this-package-does-not-exist-xyz-123'];
const NEWEST = 6;
/** Python projects, name or name==version to keep that version besides the newest ones. */
const PYTHON = ['requests==2.32.0', 'requests==2.32.1', 'pycrypto', 'ruff', 'python-dateutil', 'this-package-does-not-exist-xyz-123', 'reqeusts', 'pythondateutil'];

/** Composer packages, vendor/name or vendor/name@version to keep that version besides the newest ones. */
const PACKAGIST = [
  'monolog/monolog@1.0.1',
  'monolog/monolog@3.0.0-RC1',
  'guzzlehttp/guzzle@8.2.0',
  'guzzlehttp/guzzle@7.0.0-rc.1',
  'symfony/console@v8.1.0-RC1',
  'symfony/console@v8.1.0-BETA3',
  'php-http/discovery',
  'swiftmailer/swiftmailer',
  'intercom/intercom-php',
  'this-vendor-does-not-exist-xyz/nothing-123',
];
/** The User-Agent of the requests to Packagist: it names the script, not a person (decision D-133). */
const RECORD_USER_AGENT = 'depcurfew-record';

type Json = Record<string, unknown>;

const target = new URL('../tests/fixtures/registry/', import.meta.url);
const pythonTarget = new URL('../tests/fixtures/pypi/', import.meta.url);
const osvTarget = new URL('../tests/fixtures/osv/', import.meta.url);
const packagistTarget = new URL('../tests/fixtures/packagist/', import.meta.url);

function fileName(name: string): string {
  return `${name.replace('/', '__')}.json`;
}

const fields = values(environment.npmRegistry.api)[0];
if (fields === undefined) throw new Error('the knowledge base has no npm registry fact');

function trim(document: Json, keep: readonly string[]): Json {
  const { timeField, versionsField, distTagsField, scriptsField, deprecatedField } = fields as NonNullable<typeof fields>;
  const time = (document[timeField] ?? {}) as Record<string, string>;
  const versions = (document[versionsField] ?? {}) as Record<string, Json>;
  const tags = (document[distTagsField] ?? {}) as Record<string, string>;
  const byTime = Object.keys(versions).sort((a, b) => Date.parse(time[b] ?? '') - Date.parse(time[a] ?? ''));
  const kept = new Set([...Object.values(tags), ...byTime.slice(0, NEWEST), ...keep].filter((version) => versions[version] !== undefined));
  return {
    name: document['name'],
    [distTagsField]: tags,
    [timeField]: Object.fromEntries(Object.entries(time).filter(([key]) => kept.has(key) || key === 'created' || key === 'modified')),
    [versionsField]: Object.fromEntries(
      [...kept].map((version) => {
        const entry = versions[version] as Json;
        return [version, { name: entry['name'], version, ...(entry[scriptsField] === undefined ? {} : { [scriptsField]: entry[scriptsField] }), ...(entry[deprecatedField] === undefined ? {} : { [deprecatedField]: entry[deprecatedField] }) }];
      }),
    ),
  };
}

const index = values(environment.pypiIndex.api)[0];
if (index === undefined) throw new Error('the knowledge base has no Python package index fact');

function trimPage(page: Json, name: string, keep: readonly string[]): Json {
  const files = ((page[index!.filesField] ?? []) as Json[]).filter((file) => typeof file[index!.filenameField] === 'string');
  const versionOf = (file: Json) => fileVersion(String(file[index!.filenameField]), normalizePythonName(name))?.version;
  const newestFirst = [...files].sort((a, b) => Date.parse(String(b[index!.uploadTimeField] ?? '')) - Date.parse(String(a[index!.uploadTimeField] ?? '')));
  const kept = new Set<string>(keep);
  for (const file of newestFirst) {
    const version = versionOf(file);
    if (version !== undefined && kept.size < NEWEST + keep.length) kept.add(version);
  }
  return {
    name: page['name'],
    meta: page['meta'],
    ...(page[index!.statusField] === undefined ? {} : { [index!.statusField]: page[index!.statusField] }),
    [index!.versionsField]: page[index!.versionsField],
    [index!.filesField]: files
      .filter((file) => kept.has(versionOf(file) ?? ''))
      .map((file) => ({
        [index!.filenameField]: file[index!.filenameField],
        ...(file[index!.uploadTimeField] === undefined ? {} : { [index!.uploadTimeField]: file[index!.uploadTimeField] }),
        [index!.yankedField]: file[index!.yankedField] ?? false,
      })),
  };
}

async function recordPython(): Promise<Json> {
  mkdirSync(pythonTarget, { recursive: true });
  const keep = new Map<string, string[]>();
  for (const entry of PYTHON) {
    const [name = '', version] = entry.split('==');
    keep.set(name, [...(keep.get(name) ?? []), ...(version === undefined ? [] : [version])]);
  }
  const recorded: Json = {};
  for (const [name, versions] of keep) {
    const response = await fetch(projectUrl(defaultIndex(), name), { headers: { accept: index!.accept } });
    const body = response.ok ? trimPage((await response.json()) as Json, name, versions) : { status: response.status };
    writeFileSync(new URL(`${normalizePythonName(name)}.json`, pythonTarget), `${JSON.stringify(body, null, 2)}\n`);
    recorded[name] = response.status;
  }
  return recorded;
}

async function recordNpm(): Promise<void> {
  mkdirSync(target, { recursive: true });
  const recorded: Json = {};
  for (const entry of PACKAGES) {
    const at = entry.indexOf('@', 1);
    const name = at === -1 ? entry : entry.slice(0, at);
    const keep = at === -1 ? [] : [entry.slice(at + 1)];
    const response = await fetch(packumentUrl(defaultRegistry(), name), { headers: { accept: 'application/json' } });
    const body = response.ok ? trim((await response.json()) as Json, keep) : { status: response.status };
    writeFileSync(new URL(fileName(name), target), `${JSON.stringify(body, null, 2)}\n`);
    recorded[name] = response.status;
  }
  writeFileSync(new URL('recorded.json', target), `${JSON.stringify({ recordedAt: new Date().toISOString(), registry: defaultRegistry(), status: recorded }, null, 2)}\n`);
  console.log(`Recorded ${PACKAGES.length} responses in ${fileURLToPath(target)}`);
}

/**
 * The answer of OSV.dev for the queries in querybatch.json, kept with them; recorded.json gets the date and no longer
 * names the records a response was put together from.
 */
async function recordOsv(): Promise<void> {
  const file = new URL('querybatch.json', osvTarget);
  const { queries } = JSON.parse(readFileSync(file, 'utf8')) as { queries: unknown[] };
  const response = await fetch(osvBatchUrl(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ queries }) });
  if (!response.ok) throw new Error(`${osvBatchUrl()} answered HTTP ${response.status}`);
  const answer = (await response.json()) as Json;
  writeFileSync(file, `${JSON.stringify({ queries, response: answer }, null, 2)}\n`);
  writeFileSync(new URL('recorded.json', osvTarget), `${JSON.stringify({ recordedAt: new Date().toISOString(), api: osvBatchUrl() }, null, 2)}\n`);
  console.log(`Recorded the answer to ${queries.length} queries in ${fileURLToPath(osvTarget)}`);
}

/** A list of versions in Packagist's minified form (MetadataMinifier::minify): each entry holds what changed. */
function minify(versions: readonly Json[]): Json[] {
  const { unsetValue } = packagistApi();
  const minified: Json[] = [];
  let last: Json | undefined;
  for (const version of versions) {
    if (last === undefined) {
      last = { ...version };
      minified.push({ ...version });
      continue;
    }
    const changes: Json = {};
    for (const [key, value] of Object.entries(version)) {
      if (!Object.hasOwn(last, key) || JSON.stringify(last[key]) !== JSON.stringify(value)) {
        changes[key] = value;
        last[key] = value;
      }
    }
    for (const key of Object.keys(last)) {
      if (!Object.hasOwn(version, key)) {
        changes[key] = unsetValue;
        delete last[key];
      }
    }
    minified.push(changes);
  }
  return minified;
}

/** The metadata of one package cut down to the newest versions (by publication time) and `keep`, in Packagist's order. */
function trimPackagist(document: Json, name: string, keep: readonly string[]): Json {
  const api = packagistApi();
  const list = ((document[api.packagesField] ?? {}) as Record<string, unknown[]>)[name] ?? [];
  const expanded = expandVersions(list, document[api.minifiedField] === api.minifiedValue, api) ?? [];
  const when = (version: Json) => String(version[api.publishedField] ?? version[api.timeField] ?? '');
  const newest = new Set([...expanded].sort((a, b) => when(b).localeCompare(when(a))).slice(0, NEWEST));
  const kept = expanded.filter((version) => newest.has(version) || keep.includes(String(version[api.versionField])));
  const missing = keep.filter((version) => !kept.some((entry) => entry[api.versionField] === version));
  if (missing.length > 0) throw new Error(`${metadataUrl(name)} has no version ${missing.join(', ')}`);
  return { [api.packagesField]: { [name]: minify(kept) }, [api.minifiedField]: api.minifiedValue };
}

async function recordPackagist(): Promise<void> {
  const keep = new Map<string, string[]>();
  for (const entry of PACKAGIST) {
    const [name = '', version] = entry.split('@');
    keep.set(name, [...(keep.get(name) ?? []), ...(version === undefined ? [] : [version])]);
  }
  // Every answer is read before anything is written, so that a failed request leaves the recordings as they were.
  const answers: { name: string; status: number; body: Json }[] = [];
  for (const [name, versions] of keep) {
    const response = await fetch(metadataUrl(name), { headers: { 'user-agent': RECORD_USER_AGENT, accept: 'application/json' } });
    if (response.status === packagistApi().notFoundStatus) {
      answers.push({ name, status: response.status, body: { status: response.status } });
      continue;
    }
    if (!response.ok) throw new Error(`${metadataUrl(name)} answered HTTP ${response.status}`);
    answers.push({ name, status: response.status, body: trimPackagist((await response.json()) as Json, name, versions) });
  }
  mkdirSync(packagistTarget, { recursive: true });
  for (const { name, body } of answers) writeFileSync(new URL(fileName(name), packagistTarget), `${JSON.stringify(body, null, 2)}\n`);
  const status = Object.fromEntries(answers.map(({ name, status }) => [name, status]));
  writeFileSync(
    new URL('recorded.json', packagistTarget),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), repository: packagistUrl(), userAgent: RECORD_USER_AGENT, status }, null, 2)}\n`,
  );
  console.log(`Recorded ${answers.length} responses in ${fileURLToPath(packagistTarget)}`);
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only !== undefined && only !== 'npm' && only !== 'pypi' && only !== 'packagist' && only !== 'osv') throw new Error(`unknown registry '${only}'; use npm, pypi, packagist or osv`);
  if (only === 'osv') {
    await recordOsv();
    return;
  }
  if (only === 'packagist') {
    await recordPackagist();
    return;
  }
  if (only !== 'pypi') await recordNpm();
  if (only !== 'npm') {
    const python = await recordPython();
    writeFileSync(new URL('recorded.json', pythonTarget), `${JSON.stringify({ recordedAt: new Date().toISOString(), index: defaultIndex(), status: python }, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(python).length} responses in ${fileURLToPath(pythonTarget)}`);
  }
  if (only === undefined) {
    await recordPackagist();
    await recordOsv();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
