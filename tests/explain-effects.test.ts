// depcurfew explain says, for each tool, what installScripts and sources mean (decision D-117): the settings apply
// writes, with their files, or apply's warning when the tool cannot enforce a part, with its code and what to do. Both
// come from a plan of the repository made as apply makes it. The fixture repositories have the expected policy part of
// the output in tests/fixtures/expected/<name>/explain.json and explain.txt (see tests/support/explain-effects.ts).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WARNING_PARTS } from '../src/apply/warnings.ts';
import { buildReport, renderReport } from '../src/cli/explain.ts';
import { COLORED } from '../src/color.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../src/cli/run.ts';
import { explainExpectation } from './support/explain-effects.ts';

const REPOS = fileURLToPath(new URL('fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('fixtures/expected/', import.meta.url));
const DEFAULT_POLICY = readFileSync(new URL('fixtures/apply/policy.json', import.meta.url), 'utf8');

/** One fixture for every generator, with the cases of the brief: Bun, a tool without source settings, old versions, projects. */
const FIXTURES = [
  'bun-basic',
  'deno-allow-all-scripts',
  'docker-node',
  'multi-project',
  'pdm-basic',
  'pip-requirements',
  'pipenv-basic',
  'pnpm10-monorepo',
  'pnpm11-dependabot',
  'poetry-basic',
  'volta-renovate',
  'yarn-berry',
];

interface Effect {
  tool: string;
  settings: { setting: string; file: string; table?: string }[];
  warnings: { code: string; level: string; tool?: string; project?: string; message: string; fix?: string }[];
}

interface Document {
  schemaVersion: number;
  policy: { installScripts: { tools: Effect[] } | null; sources: { tools: Effect[] } | null };
  projects: { directory: string; installScripts?: { tools: Effect[] } | null; sources?: { tools: Effect[] } | null }[];
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-explain-effects-'));
  directories.push(directory);
  return directory;
}

function fixture(name: string): string {
  const directory = temporary();
  cpSync(join(REPOS, name), directory, { recursive: true });
  const own = join(EXPECTED, name, 'depcurfew.json');
  writeFileSync(join(directory, 'depcurfew.json'), existsSync(own) ? readFileSync(own, 'utf8') : DEFAULT_POLICY);
  return directory;
}

function repository(files: Record<string, string>): string {
  const directory = temporary();
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

/** Every effect of the document: the root's and the projects'. */
function effects(document: Document): Effect[] {
  return [document.policy, ...document.projects].flatMap((part) => [...(part.installScripts?.tools ?? []), ...(part.sources?.tools ?? [])]);
}

describe('explain on fixture repositories: what installScripts and sources mean for each tool', () => {
  it.each(FIXTURES)('%s', async (name) => {
    const directory = fixture(name);
    const json = await exec('explain', '--json', directory);
    const text = await exec('explain', directory);
    expect(json.code).toBe(EXIT_OK);
    expect(text.code).toBe(EXIT_OK);
    const document = JSON.parse(json.stdout) as Document;
    expect(document.schemaVersion).toBe(1);
    const expectation = explainExpectation(document, text.stdout);
    expect(expectation.json).toEqual(JSON.parse(readFileSync(join(EXPECTED, name, 'explain.json'), 'utf8')));
    expect(expectation.text).toBe(readFileSync(join(EXPECTED, name, 'explain.txt'), 'utf8'));
  });

  it.each(FIXTURES)('%s: the warnings are the ones apply gives, and apply writes the settings named', async (name) => {
    const directory = fixture(name);
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as Document;
    const apply = JSON.parse((await exec('apply', '--dry-run', '--json', directory)).stdout) as { warnings: Effect['warnings'] };
    const shown = effects(document).flatMap((effect) => effect.warnings);
    // Each warning explain shows is one of apply's, with the same code, message and fix, and none of the parts is left out.
    for (const warning of shown) expect(apply.warnings).toContainEqual(warning);
    for (const warning of apply.warnings.filter((item) => WARNING_PARTS[item.code as keyof typeof WARNING_PARTS] !== undefined)) {
      expect(shown, warning.code).toContainEqual(warning);
    }
    // apply writes every setting explain names into its file, and explain names the same settings once they are there.
    expect((await exec('apply', directory)).code).toBe(EXIT_OK);
    for (const effect of effects(document)) {
      for (const { setting, file, table } of effect.settings) {
        const written = readFileSync(join(directory, file), 'utf8');
        for (const part of setting.split('.').filter((segment) => segment !== '<package>')) expect(written, `${setting} in ${file}`).toContain(part);
        if (table !== undefined) expect(written, `[${table}] in ${file}`).toContain(`[${table}]`);
      }
    }
    // A value apply corrects (allow-all-replaced) is right after the first apply, so nothing is written for it again.
    const again = effects(JSON.parse((await exec('explain', '--json', directory)).stdout) as Document);
    effects(document).forEach((effect, index) => {
      if (effect.warnings.some((warning) => warning.code === 'allow-all-replaced')) return;
      expect(again[index]?.settings, effect.tool).toEqual(effect.settings);
    });
  });
});

describe('explain: installScripts and sources in a repository made for the case', () => {
  it('says that Bun has no setting that allows every install script, with the code and fix of apply', async () => {
    const directory = repository({
      'depcurfew.json': JSON.stringify({ version: 1, installScripts: { default: 'allow' }, targets: ['npm', 'bun'] }),
      'package.json': '{ "name": "app", "packageManager": "npm@11.20.0" }\n',
    });
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as { policy: { installScripts: unknown; sources: unknown } };
    expect(document.policy.installScripts).toEqual({
      default: 'allow',
      allow: [],
      deny: [],
      tools: [
        { tool: 'npm', settings: [{ setting: 'dangerously-allow-all-scripts', file: '.npmrc' }], warnings: [] },
        {
          tool: 'bun',
          settings: [],
          warnings: [
            {
              code: 'allow-all-unsupported',
              level: 'warning',
              tool: 'bun',
              message: 'Bun has no setting that allows every install script; "allow" not written',
              fix: 'List the packages under installScripts.allow instead',
            },
          ],
        },
      ],
    });
    expect(document.policy.sources).toBeNull();
    const text = await exec('explain', directory);
    expect(text.stdout).toContain(
      [
        '  cooldown: not managed',
        '  installScripts allow:',
        '    npm: dangerously-allow-all-scripts in .npmrc',
        '    Bun: nothing written; warning: Bun has no setting that allows every install script; "allow" not written (allow-all-unsupported); fix: List the packages under installScripts.allow instead',
        '  sources: not managed',
        '',
      ].join('\n'),
    );
  });

  it('does not name a setting of a manifest that does not exist, and gives manifest-missing instead', async () => {
    const directory = repository({ 'depcurfew.json': JSON.stringify({ version: 1, installScripts: { default: 'deny', allow: ['esbuild'] }, targets: ['deno'] }) });
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as { policy: { installScripts: { tools: Effect[] } } };
    expect(document.policy.installScripts.tools).toEqual([
      {
        tool: 'deno',
        settings: [],
        warnings: [
          {
            code: 'manifest-missing',
            level: 'warning',
            tool: 'deno',
            location: { file: 'deno.json' },
            message: 'Deno: there is no deno.json, so allowScripts is not written; depcurfew does not create project manifests',
            fix: 'If Deno installs packages for this project, create deno.json first, then run depcurfew apply again; otherwise remove "deno" from targets in depcurfew.json',
          },
        ],
      },
    ]);
  });

  it('says what pnpm writes for the sources in a project, and that the root has no tools of its own', async () => {
    const directory = repository({
      'depcurfew.json': JSON.stringify({ version: 1, sources: { git: 'deny', remoteTarball: 'deny' }, projects: ['web'] }),
      'web/package.json': '{ "name": "web", "packageManager": "pnpm@11.2.0" }\n',
      'web/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as Document;
    expect(document.policy.installScripts).toBeNull();
    expect(document.policy.sources).toEqual({ git: 'deny', remoteTarball: 'deny', tools: [] });
    expect(document.projects[0]?.installScripts).toBeNull();
    expect(document.projects[0]?.sources).toEqual({
      tools: [
        {
          tool: 'pnpm',
          settings: [{ setting: 'blockExoticSubdeps', file: 'web/pnpm-workspace.yaml' }],
          warnings: [
            {
              code: 'source-switch-indirect-only',
              level: 'warning',
              project: 'web',
              tool: 'pnpm',
              message: 'web: pnpm: blockExoticSubdeps stops git and tarball sources only for indirect dependencies; direct ones stay allowed',
              fix: 'Run depcurfew doctor, which reports direct ones in web/pnpm-lock.yaml',
            },
          ],
        },
      ],
    });
    const text = await exec('explain', directory);
    expect(text.stdout).toContain('  installScripts: not managed\n  sources git deny, remoteTarball deny: no tools to configure\n');
    expect(text.stdout).toContain(
      [
        '  targets: pnpm (detected)',
        '  sources:',
        '    pnpm: blockExoticSubdeps in web/pnpm-workspace.yaml; warning: web: pnpm: blockExoticSubdeps stops git and tarball sources only for indirect dependencies; direct ones stay allowed (source-switch-indirect-only); fix: Run depcurfew doctor, which reports direct ones in web/pnpm-lock.yaml',
        '',
      ].join('\n'),
    );
  });

  it('keeps a directory that cannot be used as an error, and still explains the others', async () => {
    const directory = repository({
      'depcurfew.json': JSON.stringify({ version: 1, installScripts: { default: 'deny' }, projects: ['web', 'missing'] }),
      'web/package.json': '{ "name": "web", "packageManager": "npm@12.0.0" }\n',
      'web/package-lock.json': '{ "lockfileVersion": 3 }\n',
    });
    const result = await exec('explain', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as Document & { projects: { error?: { code: string } }[] };
    // npm 12 blocks dependency install scripts by default: with nothing to allow or deny there is nothing to write.
    expect(document.projects[0]?.installScripts).toEqual({ tools: [{ tool: 'npm', settings: [], warnings: [] }] });
    expect(document.projects[1]?.error?.code).toBe('project-not-found');
    expect((await exec('explain', directory)).stdout).toContain('  targets: npm (detected)\n  installScripts:\n    npm: nothing to write\n');
  });

  it('marks the level word of a warning in yellow on a terminal', () => {
    const directory = repository({
      'depcurfew.json': JSON.stringify({ version: 1, installScripts: { default: 'allow' }, targets: ['bun'] }),
      'package.json': '{ "name": "app", "packageManager": "bun@1.3.5" }\n',
    });
    const colored = renderReport(buildReport(directory), COLORED);
    expect(colored).toContain(`    Bun: nothing written; ${COLORED.yellow('warning')}: Bun has no setting that allows every install script`);
  });
});
