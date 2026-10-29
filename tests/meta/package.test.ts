import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as Record<string, unknown>;

const ALLOWED_RUNTIME_DEPENDENCIES = ['yaml'];

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

describe('package.json', () => {
  it('is ESM-only', () => {
    expect(pkg['type']).toBe('module');
    expect(pkg['main']).toBeUndefined();
    expect(collectKeys(pkg['exports'])).not.toContain('require');
  });

  it(`has no runtime dependencies other than ${ALLOWED_RUNTIME_DEPENDENCIES.join(', ')}`, () => {
    const dependencies = Object.keys((pkg['dependencies'] as Record<string, string> | undefined) ?? {});
    expect(dependencies.filter((name) => !ALLOWED_RUNTIME_DEPENDENCIES.includes(name))).toEqual([]);
  });

  it.each(['peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'])(
    'has no %s',
    (field) => {
      expect(pkg[field]).toBeUndefined();
    },
  );

  it('exposes the depcurfew executable and its short name dcf', () => {
    expect(pkg['bin']).toEqual({ depcurfew: './dist/cli.js', dcf: './dist/cli.js' });
  });

  it('declares supported Node versions', () => {
    expect((pkg['engines'] as Record<string, string> | undefined)?.['node']).toMatch(/^>=\d+/);
  });

  it('is MIT-licensed and ships a LICENSE file', () => {
    expect(pkg['license']).toBe('MIT');
    const license = new URL('LICENSE', root);
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, 'utf8')).toMatch(/^MIT License/);
  });
});
