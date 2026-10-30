// Regenerates src/knowledge/popular.ts: the most downloaded packages of the npm registry, which depcurfew check compares
// package names with to find look-alikes. The registry has no "most downloaded" listing, and its search returns at most
// 250 results per query, so the script searches many common keywords and terms, keeps the weekly download count each
// result carries and writes the top packages. With the argument pypi it regenerates src/knowledge/popular-python.ts
// instead: the most downloaded projects of PyPI, from a monthly ranking of PyPI's public download statistics.
// Run it by hand with network access: npm run data:popular (or npm run data:popular -- pypi)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { environment } from '../src/knowledge/environment.ts';
import { values } from '../src/apply/facts.ts';

const COUNT = 5000;
const CONCURRENCY = 4;

/** Common npm keywords and terms; each is searched as text and as keywords:<term>. */
const TERMS = `
react vue angular svelte solid preact next nuxt remix astro gatsby vite webpack rollup esbuild babel swc parcel
typescript javascript node nodejs deno bun browser dom css sass less postcss tailwind styled emotion
eslint prettier lint linter stylelint format formatter test testing jest mocha vitest chai sinon jasmine karma
cypress playwright puppeteer selenium mock coverage istanbul benchmark
cli command terminal shell console color colors chalk ansi spinner progress prompt args argv parser options
http https request fetch ajax axios client server express koa fastify hapi router middleware proxy websocket
socket stream streams buffer events emitter promise async callback queue worker thread cluster
fs file filesystem path glob watch watcher chokidar copy rimraf mkdir tmp temp archive zip tar gzip compress
json yaml toml xml csv ini markdown html template templates handlebars ejs pug mustache
string strings text unicode utf8 encoding base64 hex uuid id random hash crypto md5 sha encryption jwt auth
oauth passport session cookie cors helmet security validation validator schema ajv joi zod yup
date time moment dayjs timezone format duration ms cron schedule
array object map set collection lodash underscore ramda functional utils util utility helpers tools
math number numbers bignumber decimal big float integer
regex regexp pattern match semver version versioning
log logger logging debug winston pino bunyan trace error errors stack
config configuration env dotenv environment settings rc
database db sql mysql postgres postgresql sqlite mongodb mongo redis orm prisma sequelize typeorm knex
graphql apollo rest api openapi swagger grpc protobuf
aws azure google cloud gcp firebase s3 lambda serverless docker kubernetes
image images svg png jpeg canvas sharp pdf video audio media
chart charts d3 graph visualization map maps
ui component components design icons icon font fonts animation
state redux mobx zustand store immutable immer
i18n intl locale translation
mobile react-native ios android electron desktop
plugin plugins loader preset polyfill shim core-js runtime transform ast parser compiler
build bundler bundle minify uglify terser optimize
package npm yarn pnpm registry dependency dependencies monorepo workspace
git github ci release changelog semantic commit hooks husky
email mail smtp nodemailer sms notification
editor codemirror monaco highlight syntax
crypto blockchain ethereum web3 bitcoin wallet
ai openai llm anthropic langchain mcp agent embedding
test-utils testing-library enzyme storybook
type types definitions typings
`
  .split(/\s+/u)
  .filter((term) => term.length >= 2);

interface Found {
  name: string;
  weekly: number;
}

function searchFacts(): { url: string; path: string; maxSize: number; field: string[] } {
  const search = values(environment.npmRegistry.search)[0];
  const api = values(environment.npmRegistry.api)[0];
  if (search === undefined || api === undefined) throw new Error('the knowledge base has no registry search fact');
  return { url: api.url, path: search.path, maxSize: search.maxSize, field: search.weeklyDownloadsField.split('.') };
}

async function search(text: string, facts: ReturnType<typeof searchFacts>): Promise<Found[]> {
  const url = new URL(facts.path.replace(/^\//u, ''), facts.url);
  url.searchParams.set('text', text);
  url.searchParams.set('size', String(facts.maxSize));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
    const body = (await response.json()) as { objects?: Record<string, unknown>[] };
    return (body.objects ?? []).flatMap((object): Found[] => {
      const name = (object['package'] as { name?: unknown } | undefined)?.name;
      let weekly: unknown = object;
      for (const key of facts.field) weekly = (weekly as Record<string, unknown> | undefined)?.[key];
      return typeof name === 'string' && typeof weekly === 'number' ? [{ name, weekly }] : [];
    });
  }
  throw new Error(`${url.href}: the registry kept failing`);
}

/** A monthly ranking of PyPI projects by downloads in the last 30 days, from PyPI's public BigQuery dataset. */
const PYPI_RANKING = 'https://raw.githubusercontent.com/hugovk/top-pypi-packages/main/top-pypi-packages.min.json';

async function python(): Promise<void> {
  const response = await fetch(PYPI_RANKING, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${PYPI_RANKING}: HTTP ${response.status}`);
  const body = (await response.json()) as { last_update?: unknown; rows?: { project?: unknown; download_count?: unknown }[] };
  const rows = (body.rows ?? []).filter((row): row is { project: string; download_count: number } => typeof row.project === 'string' && typeof row.download_count === 'number');
  if (rows.length < COUNT) throw new Error(`${PYPI_RANKING}: only ${rows.length} projects; nothing written`);
  const top = [...rows].sort((a, b) => b.download_count - a.download_count).slice(0, COUNT);
  const minimum = top.at(-1)?.download_count ?? 0;
  const names = top.map((row) => row.project).sort();
  const updated = typeof body.last_update === 'string' ? body.last_update.slice(0, 10) : 'an unknown date';
  const today = new Date().toISOString().slice(0, 10);
  const target = new URL('../src/knowledge/popular-python.ts', import.meta.url);
  writeFileSync(
    target,
    `// Generated by scripts/generate-popular.ts (npm run data:popular -- pypi); do not edit by hand.
import { verifiedOn } from './define.ts';

/**
 * The ${names.length} most downloaded PyPI projects in the 30 days before ${updated}, sorted by name. The least downloaded
 * of them had ${minimum} downloads. depcurfew check flags Python names that are close to one of them.
 */
export const popularPythonPackages = verifiedOn('${today}').uncertain(
  ${JSON.stringify(names)},
  'https://github.com/pypi/warehouse/blob/c137701f3afcd80c346c574c31c9b46eeb738664/docs/user/api/bigquery.md',
  'Taken from the monthly ranking at https://hugovk.github.io/top-pypi-packages/, which a PyPA member computes from the download statistics table that PyPI publishes in BigQuery (bigquery-public-data.pypi.file_downloads); PyPI publishes no ranking itself, and downloads include mirrors and CI.',
);
`,
  );
  console.log(`Wrote ${names.length} names (at least ${minimum} downloads in 30 days, ranking of ${updated}) to ${fileURLToPath(target)}`);
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only === 'pypi') return python();
  if (only !== undefined) throw new Error(`unknown registry '${only}'; use pypi, or nothing for npm`);
  const facts = searchFacts();
  const queries = TERMS.flatMap((term) => [term, `keywords:${term}`]);
  const best = new Map<string, number>();
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const query = queries[next++] as string;
      try {
        for (const found of await search(query, facts)) best.set(found.name, Math.max(best.get(found.name) ?? 0, found.weekly));
      } catch (error) {
        failed.push(query);
        console.error(`skipped "${query}": ${error instanceof Error ? error.message : String(error)}`);
      }
      if (next % 50 === 0) console.error(`${next}/${queries.length} searches, ${best.size} packages`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed.length > queries.length / 10) throw new Error(`${failed.length} of ${queries.length} searches failed; nothing written`);
  const top = [...best].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, COUNT);
  const minimum = top.at(-1)?.[1] ?? 0;
  const names = top.map(([name]) => name).sort();
  const today = new Date().toISOString().slice(0, 10);
  const target = new URL('../src/knowledge/popular.ts', import.meta.url);
  writeFileSync(
    target,
    `// Generated by scripts/generate-popular.ts (npm run data:popular); do not edit by hand.
import { verifiedOn } from './define.ts';

/**
 * The ${names.length} most downloaded packages found with ${queries.length} searches of the npm registry, sorted by name. The
 * least downloaded of them had ${minimum} weekly downloads. depcurfew check flags names that are close to one of them.
 */
export const popularPackages = verifiedOn('${today}').uncertain(
  ${JSON.stringify(names)},
  'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md',
  'Collected from the weekly download counts of registry search results (searches for common keywords and terms, at most 250 results each), not from a complete download ranking, so a popular package may be missing.',
);
`,
  );
  console.log(`Wrote ${names.length} names (at least ${minimum} weekly downloads, ${best.size} packages seen, ${failed.length} searches skipped) to ${fileURLToPath(target)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
