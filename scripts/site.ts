// Builds the documentation site into dist-site/ (decision D-132) from README.md, the knowledge base, schema.json and
// the templates in site/. With --versions (npm run site -- --versions) it adds the documentation of every earlier
// release tag under /<version>/ and a Versions page (decision D-139), and a banner on the current pages when the
// commit is not the release of its version (decision D-178). The output is not committed; the repository
// depcurfew/depcurfew.github.io builds and deploys it from the main branch (site/org-repo/).
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSite } from './site/build.ts';
import { readReleaseState, readVersions, siteArguments, type SiteArguments } from './site/versions.ts';

let options: SiteArguments;
try {
  options = siteArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}

const repository = new URL('../', import.meta.url);
const report = (line: string) => process.stderr.write(`${line}\n`);
const { version } = JSON.parse(readFileSync(new URL('package.json', repository), 'utf8')) as { version: string };
const versions = options.versions ? readVersions(fileURLToPath(repository), version, report) : [];
const release = options.versions ? readReleaseState(fileURLToPath(repository), version) : undefined;
const target = fileURLToPath(new URL('../dist-site/', import.meta.url));
rmSync(target, { recursive: true, force: true });
const written = buildSite(target, repository, { versions, report, ...(release === undefined ? {} : { release }) });
const earlier = versions.length === 0 ? '' : ` (with ${versions.map((entry) => entry.version).join(', ')})`;
const state = release === undefined || release.released ? '' : `; ${version} is not the latest release ${release.latest} at its tag, so the pages say so`;
console.log(`Wrote ${written.length} files to ${target}${earlier}${state}`);
