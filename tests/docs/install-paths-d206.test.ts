// Decision D-206: the install paths of the README. The hand-written text never runs `npx dcf` where depcurfew may not
// be installed yet (npm has an unrelated package named dcf, which npx would install and run), a repository without
// package.json gets a section of its own with a pinned npx release and a tools directory run without `cd … &&`, the
// SessionStart example says that it is a bash command line, and the commands of "Verifying a release" name no stale
// version: they come from the npm facts of the knowledge base, and VERIFIED_RELEASE follows ACTION_RELEASE.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { compareVersions, parseVersion } from '../../src/apply/version.ts';
import { ACTION_RELEASE, handWritten, NPX_RELEASE, readmeSections, UNVERIFIABLE_RELEASES, VERIFIED_RELEASE } from '../../src/docs/readme.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { evidenceOf } from '../../src/knowledge/facts.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { TOOLS_DIRECTORY } from '../../src/self-version.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const inputs = { tools: knowledgeBase, environment, action: read('action.yml'), workflow: read('.github/workflows/ci.yml') };
const sections = readmeSections(inputs);
const npm = knowledgeBase.find((tool) => tool.id === 'npm');
const npmFact = (name: string) => {
  const fact = npm?.extra?.[name];
  expect(fact, `npm.extra.${name}`).toBeDefined();
  return fact!;
};
const version = (text: string) => {
  const parsed = parseVersion(text);
  expect(parsed, text).toBeDefined();
  return parsed!;
};

/** The text from a heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.split(' ')[0] ?? '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `, 'u'));
  return next < 0 ? rest : rest.slice(0, next);
}

describe('npx dcf (D-206)', () => {
  it('runs nowhere in the hand-written README without --no', () => {
    // `npx dcf` in a fresh clone, before npm ci, installs the package dcf from the registry and runs its bin.
    expect([...handWritten(readme).matchAll(/npx (?!--no )(?:[^\s`]+ )*dcf\b/gu)].map((match) => match[0])).toEqual([]);
    expect(handWritten(readme)).toContain('npx --no dcf');
  });

  it('rests on the npm facts: npx asks, --yes is assumed in CI, a local bin comes first', () => {
    const prompt = values(npmFact('execPrompt'))[0] as Record<string, unknown>;
    expect(prompt).toMatchObject({ confirm: '--yes', refuse: '--no', yesAssumed: ['no TTY', 'CI'], localBinsFirst: true });
    expect(evidenceOf(npmFact('execPrompt')).map((evidence) => evidence.source)).toEqual([expect.stringMatching(/^https:\/\/github\.com\/npm\/cli\/blob\/v12\.2\.1\//u)]);
  });
});

describe('In a repository without package.json (D-206)', () => {
  const generated = sections['without-package-json'] ?? '';

  it('is a section of the installation, with a generated part', () => {
    const text = section(readme, '### In a repository without package.json');
    expect(text).toContain('<!-- BEGIN GENERATED: without-package-json -->');
    expect(generated).not.toBe('');
  });

  it('runs NPX_RELEASE with npx --yes, a release no newer than ACTION_RELEASE, with the age rule next to it', () => {
    expect(compareVersions(version(NPX_RELEASE.version), version(ACTION_RELEASE.version))).toBeLessThanOrEqual(0);
    const line = `npx --yes depcurfew@${NPX_RELEASE.version} doctor`;
    expect(generated).toContain(line);
    // The paragraph right after the example says why the release is not the newest one.
    const after = generated.slice(generated.indexOf(line));
    const paragraph = after.split('\n\n').slice(0, 3).join('\n\n');
    expect(paragraph).toContain('`cooldown.minimum`');
    expect(paragraph).toContain('ETARGET');
    expect(paragraph).toContain('hook');
    // Every npx command line of the section names depcurfew with an exact version.
    for (const match of generated.matchAll(/^npx .*/gmu)) expect(match[0]).toMatch(/^npx --yes depcurfew@\d+\.\d+\.\d+ /u);
  });

  it('installs the tools directory with --prefix and runs it by path, without cd', () => {
    expect(generated).toContain(`npm ci --ignore-scripts --prefix ${TOOLS_DIRECTORY}\n`);
    expect(generated).toContain(`node ${TOOLS_DIRECTORY}/node_modules/depcurfew/dist/cli.js doctor\n`);
    expect(generated).not.toMatch(/\bcd /u);
    expect(generated).toContain('Dependabot');
    expect(generated).toContain('[GitHub Action](#github-action)');
  });

  it('rests on the npm facts of npm ci and --prefix', () => {
    expect(values(npmFact('ciLockfile'))[0]).toMatchObject({ command: ['npm', 'ci'], needs: 'package-lock.json' });
    expect(values(npmFact('prefixOption'))[0]).toMatchObject({ option: '--prefix', short: '-C', forcesNonGlobalCommands: true });
  });

  it('is linked from the Python section instead of its own npx sentence', () => {
    expect(section(readme, '### Python projects')).toContain('(#in-a-repository-without-packagejson)');
    expect(section(readme, '### Python projects')).not.toContain('npx --yes depcurfew@<version>');
  });
});

describe('no cd … && in the install commands (D-206)', () => {
  it('is in no part of the README', () => {
    expect(readme).not.toContain(`cd ${TOOLS_DIRECTORY} &&`);
    expect(readme).toContain(`npm ci --ignore-scripts --prefix ${TOOLS_DIRECTORY}`);
  });
});

describe('SessionStart example on Windows (D-206)', () => {
  it('says that the command is bash and needs Git Bash on Windows', () => {
    const hook = sections['claude-code-hook'] ?? '';
    const example = hook.indexOf('"SessionStart"');
    expect(example).toBeGreaterThan(0);
    const after = hook.slice(example, example + 3000);
    expect(after).toContain('Git Bash');
    expect(after).toContain('PowerShell');
    const shell = values(environment.claudeCode.hookShell)[0];
    expect(shell).toMatchObject({ field: 'shell', default: 'bash', withoutGitBash: 'powershell', ignoredWithArgs: true });
  });
});

describe('Verifying a release (D-206)', () => {
  it('names no version in its hand-written text but the documented exception 1.5.0', () => {
    const text = section(handWritten(readme), '### Verifying a release');
    expect(text).toContain('<!-- BEGIN GENERATED: verify-release -->');
    expect([...new Set(text.match(/\d+\.\d+\.\d+/gu) ?? [])]).toEqual([...UNVERIFIABLE_RELEASES]);
    expect(handWritten(readme)).not.toMatch(/here for \d+\.\d+\.\d+/u);
  });

  it('follows ACTION_RELEASE unless that release cannot be verified', () => {
    expect(UNVERIFIABLE_RELEASES).toEqual(['1.5.0']);
    if ((UNVERIFIABLE_RELEASES as readonly string[]).includes(ACTION_RELEASE.version)) {
      expect(compareVersions(version(VERIFIED_RELEASE.version), version(ACTION_RELEASE.version))).toBeLessThan(0);
      expect(UNVERIFIABLE_RELEASES).not.toContain(VERIFIED_RELEASE.version);
    } else {
      expect(VERIFIED_RELEASE.version).toBe(ACTION_RELEASE.version);
    }
  });

  it('prints the npm commands of the knowledge base', () => {
    const pack = values(npmFact('packChecksum'))[0] as { command: string[]; field: string };
    const view = values(npmFact('viewChecksum'))[0] as { command: string[]; field: string };
    expect(pack).toMatchObject({ command: ['npm', 'pack', '--dry-run', '--json'], field: 'shasum' });
    expect(view).toMatchObject({ command: ['npm', 'view'], field: 'dist.shasum' });
    const block = sections['verify-release'] ?? '';
    expect(block).toContain(`${pack.command.join(' ')} | grep ${pack.field}\n`);
    expect(block).toContain(`${view.command.join(' ')} depcurfew@${VERIFIED_RELEASE.version} ${view.field}\n`);
  });

  it('has its rules in docs/RELEASING.md', () => {
    const releasing = read('docs/RELEASING.md');
    for (const name of ['ACTION_RELEASE', 'VERIFIED_RELEASE', 'UNVERIFIABLE_RELEASES', 'NPX_RELEASE']) expect(releasing, name).toContain(`\`${name}\``);
  });
});
