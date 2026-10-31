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

  const version = (name: string) => (JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;

  it('ships the licenses of what it bundles: yaml and the runtime helpers of rolldown', () => {
    const licenses = readFileSync(join(ROOT, 'action/THIRD_PARTY_LICENSES.md'), 'utf8');
    expect(licenses).toContain(`## yaml ${version('yaml')}`);
    expect(licenses).toContain(readFileSync(join(ROOT, 'node_modules/yaml/LICENSE'), 'utf8').trim());
    expect(readFileSync(join(ROOT, 'action/depcurfew.mjs'), 'utf8')).toContain('// \\0rolldown/runtime.js\n');
    expect(licenses).toContain(`## rolldown ${version('rolldown')}`);
    expect(licenses).toContain(readFileSync(join(ROOT, 'node_modules/rolldown/LICENSE'), 'utf8').split('end of terms and conditions')[0]?.trim());
    expect(licenses).toContain(readFileSync(join(ROOT, 'node_modules/rolldown/THIRD-PARTY-LICENSE'), 'utf8').trim());
  });

  it('starts with the license notice of yaml, which ISC asks for in every copy, and points to the other licenses', () => {
    const head = readFileSync(join(ROOT, 'action/depcurfew.mjs'), 'utf8').split('\nimport ', 1)[0] ?? '';
    const comment = head
      .split('\n')
      .map((line) => line.replace(/^\/\/ ?/u, ''))
      .join('\n');
    expect(head.split('\n').every((line) => line.startsWith('//'))).toBe(true);
    expect(comment).toContain(`yaml ${version('yaml')} (ISC):`);
    expect(comment).toContain(readFileSync(join(ROOT, 'node_modules/yaml/LICENSE'), 'utf8').trim());
    expect(comment).toContain('THIRD_PARTY_LICENSES.md');
  });
});
