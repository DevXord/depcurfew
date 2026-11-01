// Findings of the third verification of 1.3.0 in the Claude Code hook (decision D-123), with the verifier's repository
// P: env -S, OLDPWD set by a name the shell builds, a popd that fails, a trap that changes directory before the
// install, an alias that ends in a blank, PIPENV_PIPFILE, a file run with ., and the file named in an override's
// message. Ordinary commands stay quiet.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

const policy = (document: object) => JSON.stringify({ version: 1, ...document });

/**
 * The verifier's repository P: a git repository whose root policy waits a day, pkgs/strict with a policy of 90 days,
 * pkgs/other without one and the symlink l to pkgs/strict/sub. @types/node@26.6.6 was published 17 hours before NOW,
 * so both policies deny it; with `relaxed` the root policy waits an hour and allows it.
 */
function repository(options: { relaxed?: boolean; files?: Record<string, string> } = {}): string {
  const created = mkdtempSync(join(tmpdir(), 'depcurfew-d123-'));
  temporary.push(created);
  mkdirSync(join(created, '.git'));
  write(created, {
    'depcurfew.json': policy({ cooldown: { minimum: options.relaxed === true ? '1h' : '1d' } }),
    'package.json': '{"name":"root","private":true}',
    'pkgs/strict/depcurfew.json': policy({ cooldown: { minimum: '90d' } }),
    'pkgs/strict/package.json': '{"name":"strict","private":true}',
    'pkgs/strict/sub/package.json': '{"name":"sub","private":true}',
    'pkgs/other/package.json': '{"name":"other","private":true}',
    ...options.files,
  });
  symlinkSync(join(created, 'pkgs', 'strict', 'sub'), join(created, 'l'));
  return created;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, cwd: string, projectDir: string | undefined, tool = 'Bash'): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => projectDir,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const STRICT = 'pkgs/strict/depcurfew.json requires 90 days';
const PACKAGE = '@types/node@26.6.6';

describe('env -S reads its string again as arguments (N1)', () => {
  it.each([
    [`env -S'-C pkgs/strict npm install ${PACKAGE}'`],
    [`env -S'-C pkgs/strict' npm install ${PACKAGE}`],
    [`env -S"--chdir=pkgs/strict npm install ${PACKAGE}"`],
    [`env -S '-Cpkgs/strict npm install ${PACKAGE}'`],
  ])('checks %s in pkgs/strict', async (command) => {
    const root = repository({ relaxed: true });
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
  });

  it('judges an override inside the string by the policy of env -C', async () => {
    const root = repository({ relaxed: true });
    const answer = await hook("env -S'-C pkgs/strict npm ci --min-release-age=30'", root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('sets the release-age delay to 30 days, shorter than the 90 days in pkgs/strict/depcurfew.json');
  });
});

describe('the directory of cd - and popd (N2, N3)', () => {
  it.each([
    [`cd pkgs/other; X=OLD; declare "\${X}PWD=$PWD/../strict"; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; X=OLD; printf -v "\${X}PWD" %s "$PWD/../strict"; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; X=OLDPW; read -r "\${X}D" <<< "$PWD/../strict"; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; eval "OLD""PWD=$PWD/../strict"; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; eval OLD''PWD=$PWD/../strict; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; eval $'OLD\\x50WD=pkgs/strict'; cd -; npm install ${PACKAGE}`],
    [`cd pkgs/other; export OLD\\PWD=$PWD/../strict; cd -; npm install ${PACKAGE}`],
    [`pushd pkgs/strict; popd -n; popd; npm install ${PACKAGE}`],
    [`cd /nonexistent-depcurfew-d123; cd -; npm install ${PACKAGE}`],
  ])('asks about %s, whose directory it cannot tell', async (command) => {
    const root = repository({ relaxed: true });
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision, command).toBe('ask');
    expect(answer.permissionDecisionReason, command).toContain('depcurfew cannot tell which directory');
  });

  it('denies an install after a popd that fails on an empty stack', async () => {
    const root = repository({ relaxed: true });
    const answer = await hook(`pushd pkgs/strict; dirs -c; popd; npm install ${PACKAGE}`, root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
  });

  it('follows cd - and popd back to the working directory', async () => {
    const root = repository({ relaxed: true });
    for (const command of [`cd pkgs/strict; cd -; npm install ${PACKAGE}`, `pushd pkgs/strict; popd; npm install ${PACKAGE}`, `cd -P l/..; cd -; npm install ${PACKAGE}`]) {
      expect(await hook(command, root, root), command).toEqual({});
    }
  });
});

describe('a trap, an alias and a file that change where the install runs (N4, N5, N8)', () => {
  it.each([
    [`trap 'cd pkgs/strict' DEBUG; npm install ${PACKAGE}`],
    [`trap 'pushd pkgs/strict' DEBUG; npm install ${PACKAGE}`],
    [`trap 'cd pkgs/strict' DEBUG\nnpm install ${PACKAGE}`],
    [`trap 'cd pkgs/strict' ERR; false; npm install ${PACKAGE}`],
    [`echo "cd pkgs/strict" > x.sh; . ./x.sh; npm install ${PACKAGE}`],
  ])('asks about %s', async (command) => {
    const root = repository({ relaxed: true });
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('depcurfew cannot tell which directory');
  });

  it('checks the next word of an alias that ends in a blank', async () => {
    const root = repository();
    const answer = await hook(`shopt -s expand_aliases\nalias n='npm '\nalias x='install ${PACKAGE}'\nn x`, root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(PACKAGE);
  });
});

describe('the activation script of a Python virtual environment keeps the directory known', () => {
  /** A virtual environment as venv makes it: pyvenv.cfg in its directory, the activation scripts under bin and Scripts. */
  const venv = (directory: string, marker = true): Record<string, string> => ({
    ...(marker ? { [`${directory}/pyvenv.cfg`]: 'home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.14.0\n' } : {}),
    [`${directory}/bin/activate`]: '# This file must be used with "source bin/activate"\n',
    [`${directory}/bin/activate.fish`]: '# fish\n',
    [`${directory}/Scripts/Activate.ps1`]: '# PowerShell\n',
  });

  it.each([
    ['source .venv/bin/activate && pip install requests'],
    ['. .venv/bin/activate && pip install requests'],
    ['source .venv/bin/activate.fish; pip install requests'],
    ['cd pkgs/other && source ../../.venv/bin/activate && pip install requests'],
    ['source .venv/bin/activate && pytest'],
  ])('%s is checked as if nothing were sourced', async (command) => {
    const root = repository({ files: venv('.venv') });
    expect(await hook(command, root, root)).toEqual({});
  });

  it('reads the activation scripts of PowerShell', async () => {
    const root = repository({ files: venv('.venv') });
    for (const command of ['. .venv\\Scripts\\Activate.ps1; pip install requests', '& .venv/Scripts/Activate.ps1; pip install requests']) {
      expect(await hook(command, root, root, 'PowerShell'), command).toEqual({});
    }
  });

  it('still checks the install in the directory it runs in', async () => {
    const root = repository({ relaxed: true, files: venv('pkgs/strict/.venv') });
    const answer = await hook(`cd pkgs/strict && source .venv/bin/activate && npm install ${PACKAGE}`, root, root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
  });

  it('asks when the directory holds no pyvenv.cfg', async () => {
    const root = repository({ files: venv('.venv', false) });
    const answer = await hook('source .venv/bin/activate && pip install requests', root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('as the activation script of a virtual environment in ".venv", which holds no pyvenv.cfg');
  });

  it.each([
    [`echo 'cd pkgs/strict' > .venv/bin/activate; source .venv/bin/activate && npm install ${PACKAGE}`],
    [`cat > .venv/bin/activate <<EOF\ncd pkgs/strict\nEOF\nsource .venv/bin/activate && npm install ${PACKAGE}`],
    [`echo 'cd pkgs/strict' | tee .venv/bin/activate >/dev/null; source .venv/bin/activate && npm install ${PACKAGE}`],
    [`cp pkgs/evil.sh .venv/bin/activate && source .venv/bin/activate && npm install ${PACKAGE}`],
    [`ln -sf ../../pkgs/evil.sh .venv/bin/activate && source .venv/bin/activate && npm install ${PACKAGE}`],
  ])('asks about %s, which writes the script first', async (command) => {
    const root = repository({ relaxed: true, files: { ...venv('.venv'), 'pkgs/evil.sh': 'cd pkgs/strict\n' } });
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('after a command on the line that may write it');
  });
});

describe('PIPENV_PIPFILE (N7)', () => {
  it('reads the sources of the Pipfile it names', async () => {
    const pipfile = '[[source]]\nurl = "https://pypi.mirror.example/simple"\nverify_ssl = true\nname = "mirror"\n\n[packages]\nrequests = "*"\n';
    const root = repository({ relaxed: true, files: { 'pipenv-first/Pipfile': pipfile } });
    const answer = await hook('PIPENV_PIPFILE=../../pipenv-first/Pipfile pipenv install requests', join(root, 'pkgs', 'other'), root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('the install would use the index https://pypi.mirror.example/simple');
  });
});

describe('the message of an override names the policy file (N10)', () => {
  it('names pkgs/strict/depcurfew.json', async () => {
    const root = repository({ relaxed: true });
    const answer = await hook('cd pkgs/strict && npm install lodash@4.17.21 --min-release-age=30', root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('shorter than the 90 days in pkgs/strict/depcurfew.json');
  });
});

describe('ordinary commands stay quiet', () => {
  it.each([
    ['git status'],
    ['ls'],
    ['npm run build'],
    ['npm test'],
    ['pip list'],
    ['python script.py'],
    ['pytest'],
    ['cd sub && npm test'],
    ['pushd sub; make; popd'],
    ["trap 'rm -f tmp' EXIT"],
    ['source .venv/bin/activate && pytest'],
    ['cd pkgs/strict && npm ci'],
    ['. ./scripts/env.sh && npm run lint'],
    ["env -S'npm test'"],
  ])('%s', async (command) => {
    const root = repository();
    expect(await hook(command, root, root)).toEqual({});
  });
});
