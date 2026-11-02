// Builds the documentation site into dist-site/ (decision D-132) from README.md, the knowledge base, schema.json and
// the templates in site/. The output is not committed; .github/workflows/pages.yml builds and deploys it.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSite } from './site/build.ts';

const target = fileURLToPath(new URL('../dist-site/', import.meta.url));
rmSync(target, { recursive: true, force: true });
const written = buildSite(target);
console.log(`Wrote ${written.length} files to ${target}`);
