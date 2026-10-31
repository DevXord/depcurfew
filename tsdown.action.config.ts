// The GitHub Action runs action/depcurfew.mjs from the action's own checkout, without npm install, so the bundle
// includes the yaml dependency. It is committed and must equal a fresh build (tests/action/bundle.test.ts).
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const yaml = new URL('node_modules/yaml/', import.meta.url);
const yamlVersion = (JSON.parse(readFileSync(new URL('package.json', yaml), 'utf8')) as { version: string }).version;
const yamlLicense = readFileSync(new URL('LICENSE', yaml), 'utf8').trim();

// The bundle can be copied on its own, so it carries the license notice of what it bundles (ISC asks for it in all
// copies); THIRD_PARTY_LICENSES.md next to it has every license text.
const banner = [
  'depcurfew GitHub Action (MIT), built from https://github.com/DevXord/depcurfew with npm run build:action.',
  'It bundles the runtime helpers of rolldown (MIT) and yaml; their licenses are in THIRD_PARTY_LICENSES.md.',
  '',
  `yaml ${yamlVersion} (ISC):`,
  '',
  ...yamlLicense.split('\n'),
]
  .map((line) => `// ${line}`.trimEnd())
  .join('\n');

export default defineConfig({
  entry: { depcurfew: 'src/action-main.ts' },
  outDir: 'action',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // yaml is the only runtime dependency; the bundle may import nothing but Node built-ins.
  deps: { alwaysBundle: ['yaml'], onlyBundle: ['yaml'], onlyImport: [] },
  dts: false,
  clean: false,
  minify: false,
  banner,
  outExtensions: () => ({ js: '.mjs' }),
});
