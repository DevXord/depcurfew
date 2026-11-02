// Builds the documentation site into dist-site/ (decision D-132) from README.md, the knowledge base, schema.json and
// the templates in site/. With --versions (npm run site -- --versions) it adds the documentation of every earlier
// release tag under /<version>/ and a Versions page (decision D-139). The output is not committed; the repository
// depcurfew/depcurfew.github.io builds and deploys it from the latest release (site/org-repo/).
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSite } from './site/build.ts';
import { readVersions, siteArguments, type SiteArguments } from './site/versions.ts';

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
const target = fileURLToPath(new URL('../dist-site/', import.meta.url));
rmSync(target, { recursive: true, force: true });
const written = buildSite(target, repository, { versions, report });
const earlier = versions.length === 0 ? '' : ` (with ${versions.map((entry) => entry.version).join(', ')})`;
console.log(`Wrote ${written.length} files to ${target}${earlier}`);
