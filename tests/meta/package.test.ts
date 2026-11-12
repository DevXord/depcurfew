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
    // Written the way npm normalizes it, so publishing does not warn that it rewrote the paths.
    expect(pkg['bin']).toEqual({ depcurfew: 'dist/cli.js', dcf: 'dist/cli.js' });
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

// Decision D-199: the version in package-lock.json is the one of package.json, and CHANGELOG.md starts with the section
// of that version or with "## Unreleased", where changes wait for the next release; the Release workflow then requires
// the section of the tag itself.
describe('the version', () => {
  it('is the same in package.json and in both fields of package-lock.json', () => {
    const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as { version?: string; packages?: Record<string, { version?: string }> };
    expect({ version: lock.version, root: lock.packages?.['']?.version }).toEqual({ version: pkg['version'], root: pkg['version'] });
  });

  it('names the first section of CHANGELOG.md, unless that section is "## Unreleased"', () => {
    const first = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
      .split(/\r?\n/u)
      .find((line) => line.startsWith('## '));
    expect(['## Unreleased', `## ${String(pkg['version'])}`]).toContain(first);
  });

  it('keeps the section of the version of package.json under "## Unreleased", and every section with its heading', () => {
    const text = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
    const headings = text.split(/\r?\n/u).filter((line) => line.startsWith('## '));
    expect(headings).toContain(`## ${String(pkg['version'])}`);
    // A section ends before the next "## ": subsections without a heading of their own would read as the section above.
    expect(text).not.toMatch(/\n\n\n### /u);
    expect(headings.filter((line) => line === '## Unreleased').length).toBeLessThanOrEqual(1);
  });
});
