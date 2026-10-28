import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  fixedExtension: false,
  clean: true,
});
