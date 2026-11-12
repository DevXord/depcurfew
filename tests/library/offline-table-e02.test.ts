// What checkSpecs answers without the network (E02), the way agentcurfew and other programs call it: a fetch that
// refuses every request, the default policy, and the popular names of defaultPopularNames. Each row is a spec with the
// kind of the report, its findings and the number of requests checkSpecs tried. Specs of ecosystems depcurfew does not
// look up (nuget:, cargo:, crates:, gem:, jsr:) are kind "other" with the error unverified, and no request is made for
// them: a program can tell them apart from packages that could not be reached.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Library from '../../src/index.ts';
import { builtLibrary } from '../support/library-types.ts';

const NOW = new Date('2026-11-12T00:00:00Z');

/** spec, kind, findings as level:code, requests tried. */
const TABLE: [string, string, string[], number][] = [
  ['left-pad', 'registry', ['error:unverified'], 1],
  ['left-pad@1.3.0', 'registry', ['error:unverified'], 1],
  ['npm:left-pad', 'registry', ['error:unverified'], 1],
  ['@scope/name@1.0.0', 'registry', ['error:unverified'], 1],
  ['lodahs', 'registry', ['error:similar-name', 'error:unverified'], 1],
  ['pypi:requests==2.32.3', 'registry', ['error:unverified'], 1],
  ['pypi:reqeusts', 'registry', ['error:similar-name', 'error:unverified'], 1],
  ['pypi:.', 'workspace', ['warning:unchecked-source'], 0],
  ['pypi:.[dev]', 'workspace', ['warning:unchecked-source'], 0],
  ['composer:psr/log', 'registry', ['error:unverified'], 1],
  ['git+https://github.com/a/b', 'git', ['error:forbidden-source'], 0],
  ['github:a/b', 'git', ['error:forbidden-source'], 0],
  ['https://example.com/x.tgz', 'remoteTarball', ['error:forbidden-source'], 0],
  ['file:../x.tgz', 'file', ['warning:unchecked-source'], 0],
  ['./dir', 'directory', ['warning:unchecked-source'], 0],
  ['workspace:*', 'workspace', ['warning:unchecked-source'], 0],
  ['nuget:Newtonsoft.Json', 'other', ['error:unverified'], 0],
  ['nuget:Newtonsoft.Json@13.0.3', 'other', ['error:unverified'], 0],
  ['cargo:serde', 'other', ['error:unverified'], 0],
  ['cargo:serde@1.0.0', 'other', ['error:unverified'], 0],
  ['crates:serde', 'other', ['error:unverified'], 0],
  ['gem:rails', 'other', ['error:unverified'], 0],
  ['jsr:@std/path', 'other', ['error:unverified'], 0],
  ['', 'invalid', ['error:invalid-spec'], 0],
  ['Foo Bar', 'invalid', ['error:invalid-spec'], 0],
];

let directory = '';
let library: typeof Library;
beforeAll(async () => {
  library = await builtLibrary();
  directory = mkdtempSync(join(tmpdir(), 'depcurfew-e02-'));
  writeFileSync(join(directory, 'depcurfew.json'), library.renderPolicy(library.DEFAULT_POLICY));
});
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

describe('checkSpecs without the network (E02)', () => {
  it.each(TABLE)('%j: kind %s, %j, %i requests', async (spec, kind, findings, requests) => {
    const urls: string[] = [];
    const refuse: Library.FetchLike = async (url) => {
      urls.push(url);
      throw new Error('no network');
    };
    const [report] = await library.checkSpecs([spec], { ...library.defaultPopularNames(), policy: library.loadPolicy(directory), fetch: refuse, now: NOW, registry: 'https://registry.npmjs.org/' });
    expect(report?.spec).toBe(spec);
    expect(report?.kind).toBe(kind);
    expect(report?.findings.map((finding) => `${finding.level}:${finding.code}`)).toEqual(findings);
    expect(urls).toHaveLength(requests);
    for (const finding of report?.findings ?? []) {
      expect(finding.message, spec).not.toBe('');
      expect(finding.fix, spec).not.toBe('');
    }
  });

  it('says which protocol it does not look up', async () => {
    const reports = await library.checkSpecs(['nuget:Newtonsoft.Json', 'cargo:serde'], { policy: library.loadPolicy(directory), fetch: async () => Promise.reject(new Error('no network')), now: NOW, registry: 'https://registry.npmjs.org/', popular: new library.PopularNames([]) });
    expect(reports.map((report) => report.findings[0]?.message)).toEqual([
      'it is not looked up: it uses the nuget: protocol, which depcurfew does not look up',
      'it is not looked up: it uses the cargo: protocol, which depcurfew does not look up',
    ]);
  });
});
