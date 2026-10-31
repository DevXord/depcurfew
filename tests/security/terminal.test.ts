// Terminal control sequences in a repository or a registry response (a package name in a lockfile, a file name, a
// configuration key or value, a deprecation message, an install script) never reach text output as they are: a
// crafted name could otherwise show a fake link, set the window title or clear a line in the user's terminal or CI
// log. JSON and SARIF keep the text, escaped by JSON itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAction } from '../../src/action.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { windows } from '../support/platform.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const LINK = `${ESC}]8;;http://evil.example/${BEL}lodash${ESC}]8;;${BEL}`;
const TITLE = `${ESC}]0;PWNED${BEL}`;
const CLEAR = `\r${ESC}[2K`;
/** Control characters other than tab and line feed. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
/** The colors depcurfew adds itself. */
const SGR = /\u001b\[\d+m/gu;
/** A workspace directory with control characters in its name; Windows allows none in file names. */
const PACKAGE = windows ? 'pkg' : `${TITLE}pkg`;
/** How text output shows it. */
const SHOWN_PACKAGE = windows ? 'pkg' : '\\x1b]0;PWNED\\x07pkg';

const temporary: string[] = [];
let repo = '';
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'depcurfew-terminal-'));
  temporary.push(repo);
  const files: Record<string, string> = {
    'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, sources: { git: 'deny' }, targets: 'auto' }),
    'package.json': JSON.stringify({ name: 'app', private: true, packageManager: 'npm@12.2.1', workspaces: ['packages/*'], allowScripts: { [`${TITLE}sharp`]: true } }),
    'package-lock.json': JSON.stringify(
      { name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' }, [`node_modules/${LINK}`]: { version: '1.0.0', resolved: `git+ssh://git@github.com/a/b.git#abc${CLEAR}` } } },
      null,
      2,
    ),
    [`packages/${PACKAGE}/package.json`]: JSON.stringify({ name: 'pkg', version: '1.0.0' }),
    [`packages/${PACKAGE}/.npmrc`]: 'min-release-age=0\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const packument = {
  name: 'evil-pkg',
  'dist-tags': { latest: `1.0.0` },
  versions: {
    '1.0.0': {
      name: 'evil-pkg',
      version: '1.0.0',
      deprecated: `use ${LINK} instead${TITLE}${CLEAR}ok`,
      scripts: { postinstall: `node x.js${CLEAR}nothing to see` },
    },
  },
  time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
};
const fetch: FetchLike = async (url) =>
  new URL(url).pathname === '/evil-pkg' ? new Response(JSON.stringify(packument), { status: 200 }) : new Response('{"error":"Not found"}', { status: 404 });

async function exec(argv: string[], colors = false): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text), colors: { stdout: colors, stderr: colors } }, {
    fetch,
    now: () => new Date('2026-10-30T12:00:00Z'),
    stdin: async () => '',
    home: () => repo,
  });
  return { code, stdout, stderr };
}

function expectVisible(text: string): void {
  expect(text.replace(SGR, '')).not.toMatch(CONTROL);
}

describe('control characters from untrusted sources in text output', () => {
  it('doctor shows them as \\xHH in package names, file names and configuration keys, also with colors', async () => {
    for (const colors of [false, true]) {
      const result = await exec(['doctor', repo], colors);
      expectVisible(result.stdout);
      const plain = result.stdout.replace(SGR, '');
      expect(plain).toContain('installs \\x1b]8;;http://evil.example/\\x07lodash\\x1b]8;;\\x07 from a git repository (git+ssh://git@github.com/a/b.git#abc\\x0d\\x1b[2K)');
      expect(plain).toContain('lets \\x1b]0;PWNED\\x07sharp run install scripts');
      expect(plain).toContain(`\npackages/${SHOWN_PACKAGE}/.npmrc\n`);
      expect(plain).toContain(`so min-release-age in packages/${SHOWN_PACKAGE}/.npmrc has no effect`);
    }
  });

  it('doctor --json and --sarif keep the text, escaped by JSON', async () => {
    const json = await exec(['doctor', '--json', repo]);
    expect(json.stdout).toContain('\\u001b]8;;http://evil.example/\\u0007lodash');
    const report = JSON.parse(json.stdout) as { findings: { message: string }[] };
    expect(report.findings.some((finding) => finding.message.includes(LINK))).toBe(true);
    const sarif = await exec(['doctor', '--sarif', repo]);
    expect(sarif.stdout).toContain('\\u001b]8;;http://evil.example/\\u0007lodash');
  });

  it('explain shows them as \\xHH', async () => {
    const result = await exec(['explain', repo], true);
    expectVisible(result.stdout);
    expect(result.stdout.replace(SGR, '')).toContain(`Workspaces: packages/${SHOWN_PACKAGE} (declared in package.json)`);
  });

  it('apply shows them as \\xHH in its warnings', async () => {
    const result = await exec(['apply', '--dry-run', repo], true);
    expectVisible(result.stderr);
    expect(result.stderr.replace(SGR, '')).toContain('allowScripts in package.json (line 1) lets \\x1b]0;PWNED\\x07sharp run install scripts');
  });

  it('apply --dry-run shows them as \\xHH in the diff on a terminal, and keeps the diff exact in a pipe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-terminal-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'npm@12.2.1' }));
    writeFileSync(join(directory, '.npmrc'), `# ${TITLE}note\r\nsave-exact=true\r\n`);
    const colored = await exec(['apply', '--dry-run', directory], true);
    expectVisible(colored.stdout);
    expect(colored.stdout.replace(SGR, '')).toContain(' # \\x1b]0;PWNED\\x07note\\x0d\n');
    let terminal = '';
    await run(['apply', '--dry-run', directory], { stdout: (text) => (terminal += text), stderr: () => undefined, terminal: { stdout: true, stderr: true } });
    expect(terminal).toContain(' # \\x1b]0;PWNED\\x07note\\x0d\n');
    const piped = await exec(['apply', '--dry-run', directory]);
    expect(piped.stdout).toContain(` # ${TITLE}note\r\n`);
  });

  it('apply and check show no control characters in the problems of depcurfew.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-terminal-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, [`${TITLE}x`]: 1 }));
    for (const argv of [['apply', directory], ['check', '--dir', directory, 'evil-pkg']]) {
      const result = await exec(argv, true);
      expect(result.code, argv.join(' ')).toBe(1);
      expectVisible(result.stderr);
      // The problems quote names as JSON strings, which escape control characters themselves.
      expect(result.stderr.replace(SGR, ''), argv.join(' ')).toContain('(root): unknown field "\\u001b]0;PWNED\\u0007x"');
    }
  });

  it('check shows them as \\xHH in the deprecation message and the install script from the registry', async () => {
    const result = await exec(['check', '--dir', repo, 'evil-pkg'], true);
    expectVisible(result.stdout);
    const plain = result.stdout.replace(SGR, '');
    expect(plain).toContain('runs install scripts (postinstall: node x.js\\x0d\\x1b[2Knothing to see)');
    expect(plain).toContain('is deprecated: use \\x1b]8;;http://evil.example/\\x07lodash\\x1b]8;;\\x07 instead\\x1b]0;PWNED\\x07\\x0d\\x1b[2Kok');
    const json = JSON.parse((await exec(['check', '--json', '--dir', repo, 'evil-pkg'])).stdout) as { packages: { findings: { message: string }[] }[] };
    expect(json.packages[0]?.findings.some((finding) => finding.message.includes(`instead${TITLE}`))).toBe(true);
  });

  it('check shows them as \\xHH in its notes about the registry and the dist-tag from .npmrc', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-terminal-notes-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1 }\n');
    writeFileSync(join(directory, '.npmrc'), `registry=http://127.0.0.1:9/${CLEAR}\ntag=next${TITLE}x\n`);
    const result = await exec(['check', '--dir', directory, 'evil-pkg'], true);
    expectVisible(result.stderr);
    // .npmrc ends a value at ";" (as the ini package npm uses), so the tag is next, ESC and "]0".
    expect(result.stderr.replace(SGR, '')).toContain('npm prefers the dist-tag "next\\x1b]0"');
  });

  it('the GitHub Action shows them as \\xHH in the log, the annotations and the job summary', () => {
    let log = '';
    let summary = '';
    runAction({ GITHUB_WORKSPACE: repo }, { log: (text) => (log += text), summary: (text) => (summary += text) });
    expectVisible(log);
    expectVisible(summary);
    expect(log).toContain('installs \\x1b]8;;http://evil.example/\\x07lodash\\x1b]8;;\\x07 from a git repository');
    expect(log.split('\n').find((line) => line.startsWith('::error file=package-lock.json'))).toContain('\\x1b]8;;http://evil.example/\\x07lodash');
    // Markdown shows \\ as one backslash.
    expect(summary).toContain('lets \\\\x1b\\]0;PWNED\\\\x07sharp run install scripts');
  });
});
