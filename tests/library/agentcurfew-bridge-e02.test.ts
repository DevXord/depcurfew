// agentcurfew 1.2.0 calls depcurfew's library (getVersion, loadPolicy, checkSpecs, PopularNames) offline for the
// packages MCP servers start. tests/fixtures/library/agentcurfew-1.2.0/bridge.ts mirrors that code; it must compile
// against the published types with agentcurfew's compiler options and give the same answers at run time (E02). Three
// changed copies of dist/index.d.ts show the check catches what would break agentcurfew: a renamed export, a new
// required option and a third level of findings.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Library from '../../src/index.ts';
import { builtLibrary, compileAgainst, DIST_TYPES } from '../support/library-types.ts';

const MIRROR = fileURLToPath(new URL('../fixtures/library/agentcurfew-1.2.0/bridge.ts', import.meta.url));

/** What the test uses of the mirror, which is loaded at run time: it needs the build, and npm run typecheck must not. */
interface Bridge {
  setDepcurfewLoader(load: () => Promise<unknown>): void;
  checkPackages(specs: readonly string[], root: string, now?: Date): Promise<{ state: { status: string; reason?: string; version?: string }; reports: Map<string, { spec: string; findings: { level: string; code: string }[] }> }>;
}
const NOW = new Date('2026-11-12T00:00:00Z');

let directory = '';
let library: typeof Library;
let bridge: Bridge;
beforeAll(async () => {
  library = await builtLibrary();
  bridge = (await import(new URL('../fixtures/library/agentcurfew-1.2.0/bridge.ts', import.meta.url).href)) as Bridge;
  directory = mkdtempSync(join(tmpdir(), 'depcurfew-e02-bridge-'));
});
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

/** A project directory with the default policy, or with `policy` as the text of depcurfew.json. */
function project(name: string, policy?: string): string {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'depcurfew.json'), policy ?? library.renderPolicy(library.DEFAULT_POLICY));
  return root;
}

/** A copy of dist/index.d.ts with one change; the change must apply. */
function changedTypes(name: string, from: string, to: string): string {
  const text = readFileSync(DIST_TYPES, 'utf8');
  expect(text.split(from)).toHaveLength(2);
  const file = join(directory, `${name}.d.ts`);
  writeFileSync(file, text.replace(from, to));
  return file;
}

describe('agentcurfew 1.2.0 against the published types (E02)', () => {
  it('compiles with its compiler options', () => {
    expect(compileAgainst(MIRROR)).toEqual([]);
  });

  it.each([
    ['a renamed export', 'renamed', 'export declare function checkSpecs(', 'export declare function checkPackageSpecs('],
    ['a new required option', 'required', '  popular: PopularNames;\n', '  popular: PopularNames;\n  project: string;\n'],
    ['a third level of findings', 'level', "  level: 'error' | 'warning';\n", "  level: 'error' | 'warning' | 'note';\n"],
  ])('does not compile with %s', (_, name, from, to) => {
    expect(compileAgainst(MIRROR, changedTypes(name, from, to)).length).toBeGreaterThan(0);
  });
});

describe('agentcurfew 1.2.0 at run time (E02)', () => {
  it('reports the offline findings of each package and nothing that needs the registry', async () => {
    bridge.setDepcurfewLoader(async () => library);
    const specs = ['left-pad@1.3.0', 'git+https://github.com/a/b', 'pypi:requests==2.32.3', 'nuget:Newtonsoft.Json', 'cargo:serde', 'file:../x.tgz', 'Foo Bar'];
    const { state, reports } = await bridge.checkPackages(specs, project('default'), NOW);
    expect(state).toEqual({ status: 'ready', version: library.getVersion() });
    expect([...reports.values()].map((report) => [report.spec, report.findings.map((finding) => `${finding.level}:${finding.code}`)])).toEqual([
      ['left-pad@1.3.0', []],
      ['git+https://github.com/a/b', ['error:forbidden-source']],
      ['pypi:requests==2.32.3', []],
      ['nuget:Newtonsoft.Json', []],
      ['cargo:serde', []],
      ['file:../x.tgz', ['warning:unchecked-source']],
      ['Foo Bar', ['error:invalid-spec']],
    ]);
  });

  it('says why nothing was checked: no depcurfew, another major version, no policy, a policy it cannot read', async () => {
    bridge.setDepcurfewLoader(async () => undefined);
    expect((await bridge.checkPackages(['left-pad'], project('missing'), NOW)).state.status).toBe('missing');
    bridge.setDepcurfewLoader(async () => ({ ...library, getVersion: () => '2.0.0' }));
    expect((await bridge.checkPackages(['left-pad'], project('unsupported'), NOW)).state).toEqual({ status: 'unsupported', reason: 'depcurfew 2.0.0 is outside >=1.5.2 <2' });
    bridge.setDepcurfewLoader(async () => library);
    const bare = join(directory, 'no-policy');
    mkdirSync(bare);
    expect((await bridge.checkPackages(['left-pad'], bare, NOW)).state.status).toBe('no-policy');
    expect((await bridge.checkPackages(['left-pad'], project('invalid', '{"cooldown": {"minimum": "soon"}}'), NOW)).state.status).toBe('invalid-policy');
  });
});
