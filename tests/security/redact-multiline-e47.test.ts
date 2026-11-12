// The value of a secret key may go on over several lines (E47): in YAML a block scalar (| or >), a double- or
// single-quoted scalar that does not close on its line, a plain scalar that continues on more indented lines, or a
// value on the lines below an empty one; in TOML a multi-line string (""" or ''') or an array or inline table that goes
// on. redactText, and so the diffs of apply and doctor, hide every line of such a value. Before, only the first line
// was read, and the lines after it showed the secret.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redactText, unifiedDiff } from '../../src/apply/diff.ts';
import { run } from '../../src/cli/run.ts';
import { cpuNow } from '../support/cpu-time.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const text = (...lines: string[]) => `${lines.join('\n')}\n`;
const SECRET = /s3cr3t/u;

describe('YAML values over several lines under a secret key (E47)', () => {
  it.each([
    ['a literal block scalar', text('npmAuthToken: |', '  s3cr3t-one', '  s3cr3t-two', 'npmRegistryServer: "https://registry.example.org"'), text('npmAuthToken: <redacted>', '  <redacted>', '  <redacted>', 'npmRegistryServer: "https://registry.example.org"')],
    ['a folded block scalar with a blank line', text('npmAuthToken: >-', '  s3cr3t-one', '', '  s3cr3t-two', 'enableTelemetry: false'), text('npmAuthToken: <redacted>', '  <redacted>', '', '  <redacted>', 'enableTelemetry: false')],
    ['a value on the line below an empty one', text('npmAuthToken:', '  s3cr3t', 'enableTelemetry: false'), text('npmAuthToken:', '  <redacted>', 'enableTelemetry: false')],
    ['a double-quoted scalar over three lines', text('npmAuthToken: "s3cr3t-one', '  s3cr3t-\\"two', '  s3cr3t-three"', 'enableTelemetry: false'), text('npmAuthToken: <redacted>', '  <redacted>', '  <redacted>"', 'enableTelemetry: false')],
    ["a single-quoted scalar with ''", text("npmAuthToken: 's3cr3t-one", "  s3cr3t-''two''", "  s3cr3t-three'", 'enableTelemetry: false'), text('npmAuthToken: <redacted>', '  <redacted>', "  <redacted>'", 'enableTelemetry: false')],
    ['a plain scalar that continues', text('npmAuthToken: s3cr3t-one', '  s3cr3t-two', 'enableTelemetry: false'), text('npmAuthToken: <redacted>', '  <redacted>', 'enableTelemetry: false')],
    ['a block scalar of a key in a list item', text('npmScopes:', '  acme:', '    - npmAuthToken: |', '        s3cr3t', '      npmRegistryServer: "https://r.example"'), text('npmScopes:', '  acme:', '    - npmAuthToken: <redacted>', '        <redacted>', '      npmRegistryServer: "https://r.example"')],
    ['CR LF line ends', 'npmAuthToken: |\r\n  s3cr3t\r\nenableTelemetry: false\r\n', 'npmAuthToken: <redacted>\r\n  <redacted>\r\nenableTelemetry: false\r\n'],
  ])('hides %s', (_, input, expected) => {
    expect(redactText('.yarnrc.yml', input)).toBe(expected);
    expect(redactText('.yarnrc.yml', input)).not.toMatch(SECRET);
  });

  it('shows a block scalar under another key, and keeps line numbers', () => {
    const input = text('description: |', '  a token is needed', 'npmAuthToken: |', '  s3cr3t', 'enableTelemetry: false');
    const shown = redactText('pnpm-workspace.yaml', input);
    expect(shown).toBe(text('description: |', '  a token is needed', 'npmAuthToken: <redacted>', '  <redacted>', 'enableTelemetry: false'));
    expect(shown.split('\n')).toHaveLength(input.split('\n').length);
  });
});

describe('TOML values over several lines under a secret key (E47)', () => {
  it.each([
    ['a multi-line basic string', 'uv.toml', text('password = """', 's3cr3t-one', 's3cr3t-two"""', 'exclude-newer = "3 days"'), text('password = <redacted>', '<redacted>', '<redacted>"""', 'exclude-newer = "3 days"')],
    ['a multi-line literal string', 'pyproject.toml', text('[tool.example]', "token = '''s3cr3t-one", "s3cr3t-two'''", 'other = 1'), text('[tool.example]', 'token = <redacted>', "<redacted>'''", 'other = 1')],
    ['an array', 'Pipfile', text('[source]', 'token = [', '  "s3cr3t-one",', '  "s3cr3t-two",', ']', 'name = "pypi"'), text('[source]', 'token = <redacted>', '  <redacted>', '  <redacted>', ']', 'name = "pypi"')],
    ['a quoted dotted key on one line', 'bunfig.toml', text('[install.scopes]', '"acme".token = "s3cr3t"', "'other'.token = 's3cr3t'", 'url = "https://r.example"'), text('[install.scopes]', '"acme".token = <redacted>', "'other'.token = <redacted>", 'url = "https://r.example"')],
    ['a quoted dotted key', 'bunfig.toml', text('[install.scopes]', '"acme".token = """', 's3cr3t', '"""'), text('[install.scopes]', '"acme".token = <redacted>', '<redacted>', '"""')],
  ])('hides %s', (_, file, input, expected) => {
    expect(redactText(file, input)).toBe(expected);
    expect(redactText(file, input)).not.toMatch(SECRET);
  });

  it('shows the lines of a multi-line string under another key, also after a line that reads token = """', () => {
    const input = text('description = """', 'token = """', 'not a key"""', 'name = "x"');
    // The line inside the string is hidden by its own value, which errs on the side of hiding; the rest stays.
    expect(redactText('pyproject.toml', input)).toBe(text('description = """', 'token = <redacted>', 'not a key"""', 'name = "x"'));
  });
});

describe('the diffs of apply with multi-line secrets (E47)', () => {
  it('hides every line of the value in the context of a hunk', () => {
    const before = text('npmAuthToken: |', '  s3cr3t-one', '  s3cr3t-two', 'enableTelemetry: false');
    const after = `${before}npmMinimalAgeGate: 3d\n`;
    const diff = unifiedDiff('.yarnrc.yml', before, after, 3, { redact: true });
    expect(diff).toContain('+npmMinimalAgeGate: 3d');
    expect(diff).toContain('   <redacted>');
    expect(diff).not.toMatch(SECRET);
  });

  it('shows no secret of a .yarnrc.yml in apply --dry-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-e47-'));
    temporary.push(root);
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', packageManager: 'yarn@4.18.1' }));
    writeFileSync(join(root, 'yarn.lock'), '__metadata:\n  version: 8\n');
    writeFileSync(join(root, '.yarnrc.yml'), text('npmAuthToken: |', '  s3cr3t-one', '  s3cr3t-two', 'enableTelemetry: false'));
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, targets: ['yarn'] }));
    let stdout = '';
    await run(['apply', '--dry-run', root], { stdout: (chunk) => (stdout += chunk), stderr: () => {} });
    expect(stdout).toContain('.yarnrc.yml');
    expect(stdout).not.toMatch(SECRET);
  });

  it('reads long files in linear time', () => {
    const yaml = `npmAuthToken: |\n${'  s3cr3t\n'.repeat(100_000)}${'npmAuthToken: "x\n'.repeat(20_000)}`;
    const toml = `${'token = [\n'.repeat(20_000)}${'"s3cr3t",\n'.repeat(50_000)}${']\n'.repeat(20_000)}`;
    const start = cpuNow();
    expect(redactText('.yarnrc.yml', yaml)).not.toMatch(SECRET);
    expect(redactText('uv.toml', toml)).not.toMatch(SECRET);
    expect(cpuNow() - start).toBeLessThan(2000);
  });
});
