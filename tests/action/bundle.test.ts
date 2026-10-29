// action/depcurfew.mjs is committed so that the action needs no npm install; it must be exactly what the sources
// build to, and import nothing but Node built-ins.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('action bundle', () => {
  it('equals a fresh build (run npm run build:action after changing src/)', () => {
    const out = mkdtempSync(join(tmpdir(), 'depcurfew-bundle-'));
    try {
      const build = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsdown/dist/run.mjs'), '-c', 'tsdown.action.config.ts', '-d', out], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(build.status, build.stderr).toBe(0);
      expect(readFileSync(join(out, 'depcurfew.mjs'), 'utf8')).toBe(readFileSync(join(ROOT, 'action/depcurfew.mjs'), 'utf8'));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('imports only Node built-ins', () => {
    const bundle = readFileSync(join(ROOT, 'action/depcurfew.mjs'), 'utf8');
    const imports = [...bundle.matchAll(/^import .* from "([^"]+)";$/gmu), ...bundle.matchAll(/__require\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^(node:)?(fs|path|module|process|buffer|url|os|crypto)$/u);
  });

  it('ships the licenses of what it bundles', () => {
    const licenses = readFileSync(join(ROOT, 'action/THIRD_PARTY_LICENSES.md'), 'utf8');
    const version = (JSON.parse(readFileSync(join(ROOT, 'node_modules/yaml/package.json'), 'utf8')) as { version: string }).version;
    expect(licenses).toContain(`## yaml ${version}`);
    expect(licenses).toContain(readFileSync(join(ROOT, 'node_modules/yaml/LICENSE'), 'utf8').trim());
  });
});
