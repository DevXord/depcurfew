// Records registry responses for the tests of depcurfew check, which run without network access: npm package documents
// in tests/fixtures/registry/ and Python index pages in tests/fixtures/pypi/. Each npm document is cut down to what
// check reads: dist-tags, the publish times and, for the kept versions, scripts and deprecated. Each index page keeps
// its versions and status and, for the kept versions, the name, upload time and yanked state of each file. A name the
// registry or index does not know is recorded as a 404. With osv it also sends the queries of
// tests/fixtures/osv/querybatch.json to the batch endpoint of OSV.dev (one POST, read-only) and writes the answer next
// to them, for the tests of --osv (decision D-129).
// Run by hand with network access: npm run record:registry (npm, PyPI and OSV.dev), or -- npm, -- pypi or -- osv for one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { values } from '../src/apply/facts.ts';
import { defaultRegistry, packumentUrl } from '../src/check/registry.ts';
import { environment } from '../src/knowledge/environment.ts';
import { defaultIndex, fileVersion, projectUrl } from '../src/check/pypi.ts';
import { normalizePythonName } from '../src/policy/python-names.ts';
import { osvBatchUrl } from '../src/check/osv.ts';

/** name, or name@version to keep that version besides the newest ones. */
const PACKAGES = ['lodash', 'esbuild', 'request', '@types/node', 'cross-env', 'crossenv', 'this-package-does-not-exist-xyz-123'];
const NEWEST = 6;
/** Python projects, name or name==version to keep that version besides the newest ones. */
const PYTHON = ['requests==2.32.0', 'requests==2.32.1', 'pycrypto', 'ruff', 'python-dateutil', 'this-package-does-not-exist-xyz-123', 'reqeusts', 'pythondateutil'];

type Json = Record<string, unknown>;

const target = new URL('../tests/fixtures/registry/', import.meta.url);
const pythonTarget = new URL('../tests/fixtures/pypi/', import.meta.url);
const osvTarget = new URL('../tests/fixtures/osv/', import.meta.url);

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

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only !== undefined && only !== 'npm' && only !== 'pypi' && only !== 'osv') throw new Error(`unknown registry '${only}'; use npm, pypi or osv`);
  if (only === 'osv') {
    await recordOsv();
    return;
  }
  if (only !== 'pypi') await recordNpm();
  if (only !== 'npm') {
    const python = await recordPython();
    writeFileSync(new URL('recorded.json', pythonTarget), `${JSON.stringify({ recordedAt: new Date().toISOString(), index: defaultIndex(), status: python }, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(python).length} responses in ${fileURLToPath(pythonTarget)}`);
  }
  if (only === undefined) await recordOsv();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
