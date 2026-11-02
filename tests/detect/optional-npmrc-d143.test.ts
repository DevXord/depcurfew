// explain --json and doctor: what npm does with optional dependencies for an npm install of a CI job or a Dockerfile,
// with the project .npmrc as the layer under the command line and the variables (decision D-143). Each of omit,
// include and optional is one key, the highest layer that sets it wins, and include wins over omit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';
import { Repository } from '../../src/detect/repository.ts';
import { optionalOmissions } from '../../src/doctor/install-script-packages.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d143-optional-'));
  temporary.push(root);
  for (const [file, text] of Object.entries({ 'package.json': '{"name":"app"}\n', ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const workflow = (run: string) => `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;

function optional(npmrc: string | undefined, run: string): string | undefined {
  const root = repository({ ...(npmrc === undefined ? {} : { '.npmrc': npmrc }), '.github/workflows/ci.yml': workflow(run) });
  return detectProject(root).jobs[0]?.commands[0]?.optionalDependencies;
}

describe('optionalDependencies of an npm install with the project .npmrc', () => {
  it.each([
    [undefined, 'npm ci --omit=optional', 'omitted'],
    ['include=optional\n', 'npm ci --omit=optional', 'kept'],
    ['optional=true\n', 'npm ci --omit=optional', 'kept'],
    ['include[]=optional\n', 'NPM_CONFIG_OMIT=optional npm ci', 'kept'],
    // The command line sets include, which replaces the one of .npmrc: optional is omitted.
    ['include=optional\n', 'npm ci --include=dev --omit=optional', 'omitted'],
    // The command line sets optional, which replaces optional=true of .npmrc; include of .npmrc still wins.
    ['optional=true\n', 'npm ci --no-optional', 'omitted'],
    ['include=optional\n', 'npm ci --no-optional', 'kept'],
    // A command that says nothing about them leaves it to .npmrc, which doctor reports at its own line.
    ['omit=optional\n', 'npm ci', undefined],
    ['omit=optional\n', 'npm ci --include=optional', 'kept'],
  ])('with .npmrc %j, %s gives %s', (npmrc, run, expected) => {
    expect(optional(npmrc, run)).toBe(expected);
  });

  it('is what doctor reports: an omit of the command line that .npmrc include=optional does not undo', () => {
    const npm = knowledgeBase.find((tool) => tool.id === 'npm');
    if (npm === undefined) throw new Error('no npm');
    const kept = repository({ '.npmrc': 'include=optional\n', '.github/workflows/ci.yml': workflow('npm ci --omit=optional') });
    expect(optionalOmissions(new Repository(kept), detectProject(kept), npm)).toEqual([]);
    const omitted = repository({ '.npmrc': 'include=optional\n', '.github/workflows/ci.yml': workflow('npm ci --include=dev --omit=optional') });
    expect(optionalOmissions(new Repository(omitted), detectProject(omitted), npm).map((place) => place.text)).toEqual(['the npm install in job build of .github/workflows/ci.yml (line 6)']);
  });
});
