// Records registry responses for the tests of depcurfew check (tests/fixtures/registry/), which run without network
// access. Each package document is cut down to what check reads: dist-tags, the publish times and, for the kept
// versions, scripts and deprecated. A name the registry does not know is recorded as a 404.
// Run by hand with network access: npm run record:registry
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { values } from '../src/apply/facts.ts';
import { defaultRegistry, packumentUrl } from '../src/check/registry.ts';
import { environment } from '../src/knowledge/environment.ts';

/** name, or name@version to keep that version besides the newest ones. */
const PACKAGES = ['lodash', 'esbuild', 'request', '@types/node', 'cross-env', 'crossenv', 'this-package-does-not-exist-xyz-123'];
const NEWEST = 6;

type Json = Record<string, unknown>;

const target = new URL('../tests/fixtures/registry/', import.meta.url);

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

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
