// The GitHub Action runs action/depgate.mjs from the action's own checkout, without npm install, so the bundle
// includes the yaml dependency. It is committed and must equal a fresh build (tests/action/bundle.test.ts).
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { depgate: 'src/action-main.ts' },
  outDir: 'action',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // yaml is the only runtime dependency; the bundle may import nothing but Node built-ins.
  deps: { alwaysBundle: ['yaml'], onlyBundle: ['yaml'], onlyImport: [] },
  dts: false,
  clean: false,
  minify: false,
  outExtensions: () => ({ js: '.mjs' }),
});
