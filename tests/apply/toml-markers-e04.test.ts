// depcurfew's markers in TOML files count only outside values (E04): a marker line inside a multi-line string or a
// multi-line array is text of that value, not a managed block. Before, a block wrapped in a multi-line string was
// still taken for the block: apply rewrote it inside the string and changed nothing (so the tool did not get the
// settings and doctor was clean), apply edited the lines of another key's string, and a marker in a string made the
// hand-written settings after it count as written by depcurfew. After each edit the block has to lie outside every
// value, in its table, or apply refuses the file with cannot-edit, its line and a fix.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blockStart, BLOCK_END } from '../../src/apply/block.ts';
import { managedValue } from '../../src/apply/delays.ts';
import { applyProject } from '../../src/apply/index.ts';
import { checkTomlBlock, hasManagedTomlLines, tomlBlockLines, writeTomlBlock } from '../../src/apply/toml.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { parsePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { cpuNow } from '../support/cpu-time.ts';
import { platform, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const UV_MARKER = blockStart('tool.uv');
const UV_BLOCK = [UV_MARKER, 'exclude-newer = "3 days"', 'no-build = true', BLOCK_END];
const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: ['uv'] };

function repository(pyproject: string): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-e04-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'pyproject.toml'), pyproject);
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify(POLICY, null, 2));
  return root;
}

const read = (root: string) => readFileSync(join(root, 'pyproject.toml'), 'utf8');
const lines = (...parts: (string | readonly string[])[]) => `${parts.flat().join('\n')}\n`;

describe('the TOML marker reader (E04)', () => {
  it('reads markers only where TOML has no value', () => {
    const text = lines(
      '[tool.poetry]',
      'description = """',
      UV_BLOCK,
      '"""',
      "notes = '''",
      UV_MARKER,
      "'''",
      'packages = [',
      `  ${UV_MARKER}`,
      `  ${BLOCK_END}`,
      ']',
      '[tool.uv]',
      UV_BLOCK,
    );
    expect([...tomlBlockLines(text)]).toEqual([17, 18]);
    expect(hasManagedTomlLines(lines('a = """', UV_MARKER, '"""'))).toBe(false);
    expect(hasManagedTomlLines(lines('a = 1', UV_BLOCK))).toBe(true);
  });

  it('does not count a hand-written value after a marker in a string as written by depcurfew', () => {
    const text = lines('[tool.uv]', 'note = """', UV_MARKER, '"""', 'exclude-newer = "1 hour"');
    expect(managedValue(text, 'pyproject.toml', ['tool', 'uv', 'exclude-newer'], 5)).toBe(false);
    expect(managedValue(lines('[tool.uv]', UV_BLOCK), 'pyproject.toml', ['tool', 'uv', 'exclude-newer'], 3)).toBe(true);
  });
});

describe('apply and doctor with a block in a TOML value (E04)', () => {
  it('writes a real block when the block is wrapped in a string of the table, and doctor reports it first', () => {
    const before = lines('[project]', 'name = "demo"', 'version = "0.1.0"', '', '[tool.uv]', 'note = """', UV_BLOCK, '"""');
    const root = repository(before);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift').map((finding) => finding.location?.file)).toContain('pyproject.toml');
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(read(root)).toBe(lines(before.trimEnd(), '', UV_BLOCK));
    expect(applyProject(root).changes).toEqual([]);
  });

  it('leaves the string of another table as it is', () => {
    const before = lines('[project]', 'name = "demo"', 'description = """', UV_BLOCK, '"""', '', '[tool.uv]', 'dev-dependencies = []');
    const root = repository(before);
    applyProject(root);
    expect(read(root)).toBe(lines(before.trimEnd(), '', UV_BLOCK));
  });

  it('takes markers in a comment of a multi-line array for text of the array', () => {
    const before = lines('[tool.uv]', 'dev-dependencies = [', `  ${UV_MARKER}`, `  ${BLOCK_END}`, ']');
    const root = repository(before);
    expect(applyProject(root).errors).toEqual([]);
    expect(read(root)).toBe(lines(before.trimEnd(), '', UV_BLOCK));
  });
});

describe('the check after each edit of a TOML block (E04)', () => {
  it('passes for the blocks writeTomlBlock writes', () => {
    const edited = writeTomlBlock(lines('[tool.uv]', 'note = """', UV_BLOCK, '"""'), 'tool.uv', UV_BLOCK.slice(1, -1), ['exclude-newer', 'no-build'], 'tool.uv');
    expect(() => checkTomlBlock(edited, 'tool.uv', 'tool.uv', 'project', true)).not.toThrow();
  });

  it('refuses a block inside a value, with its line and a fix', () => {
    const text = lines('[tool.uv]', 'note = """', UV_BLOCK, '"""');
    expect(() => checkTomlBlock(text, 'tool.uv', 'tool.uv', 'project', true)).toThrow(/at line 2\b/u);
    try {
      checkTomlBlock(text, 'tool.uv', 'tool.uv', 'project', true);
    } catch (error) {
      expect((error as Error).message).toBe('the block depcurfew manages for [tool.uv] would be inside the value that starts at line 2, where tools read it as text');
      expect((error as { fix?: string }).fix).toBe('Move the settings of [tool.uv] out of the value that starts at line 2, then run depcurfew apply again');
    }
  });

  it('refuses a block in another table', () => {
    const text = lines('[tool.uv]', 'a = 1', '[tool.other]', UV_BLOCK);
    expect(() => checkTomlBlock(text, 'tool.uv', 'tool.uv', 'project', true)).toThrow('the block depcurfew manages for [tool.uv] would be in [tool.other] at line 4, where uv does not read it');
  });
});

describe('apply --user and doctor --user with a marker in a TOML value (E04)', () => {
  function machine(): UserEnvironment {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-e04-user-'));
    temporary.push(root);
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'uv'), 'binary');
    const info = join(root, 'lib', 'python3.12', 'site-packages', 'uv-0.13.6.dist-info');
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'METADATA'), 'Metadata-Version: 2.4\nName: uv\nVersion: 0.13.6\n');
    writeFileSync(join(info, 'entry_points.txt'), '[console_scripts]\nuv = uv.__main__:main\n');
    return { platform, home, env: { PATH: bin } };
  }

  it('reports and replaces a shorter hand-written delay after a marker in a string', () => {
    const environment = machine();
    const policyText = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: ['uv'] });
    const policyFile = userPolicyPath(environment);
    mkdirSync(dirname(policyFile), { recursive: true });
    writeFileSync(policyFile, policyText);
    const file = userFileOf('uv', environment);
    mkdirSync(dirname(file), { recursive: true });
    const marker = blockStart(undefined, 'user');
    writeFileSync(file, lines('note = """', marker, '"""', 'exclude-newer = "1 hour"'));
    expect(runUserDoctor({ environment }).findings.map((finding) => finding.location?.line)).toContain(4);
    const parsed = parsePolicy(policyText);
    if (!parsed.ok) throw new Error('policy');
    const planned = planUserApply(parsed.policy as ResolvedPolicy, { environment });
    const after = planned.report.changes.find((change) => change.path === file)?.after ?? '';
    expect(after.startsWith(lines('note = """', marker, '"""'))).toBe(true);
    expect(after).toContain('# depcurfew: superseded by the managed block: exclude-newer = "1 hour"');
    writeUserChanges(planned);
    expect(planUserApply(parsed.policy as ResolvedPolicy, { environment }).report.changes).toEqual([]);
  });
});

describe('the TOML marker reader on large files (E04)', () => {
  it.each([
    ['8,000 empty copies of the block', lines('[tool.uv]', Array.from({ length: 8_000 }, () => [UV_MARKER, BLOCK_END]).flat())],
    ['8,000 marker lines in a string', lines('[tool.uv]', 'note = """', Array.from({ length: 4_000 }, () => [UV_MARKER, BLOCK_END]).flat(), '"""')],
    ['a string of 1 MiB of quotes and backslashes', lines('[tool.uv]', `note = """${'\\"'.repeat(170_000)}"""`, UV_MARKER)],
  ])('apply and doctor read %s quickly', (_, pyproject) => {
    expect(pyproject.length).toBeLessThan(1024 * 1024);
    const root = repository(pyproject);
    const start = cpuNow();
    runDoctor(root);
    const report = applyProject(root, { write: false });
    expect(cpuNow() - start).toBeLessThan(2000);
    expect(report.errors).toEqual([]);
    expect(report.changes.map((change) => change.file)).toContain('pyproject.toml');
  });
});
