import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { writeRequirementsBlock } from '../../src/apply/pip-requirements.ts';
import { pylockEntries, requirementsEntries, requirementsFormatOf, requirementsIncludes, uvEntries } from '../../src/doctor/python-lockfiles.ts';
import { pip } from '../../src/knowledge/pip.ts';
import { uv } from '../../src/knowledge/uv.ts';
import { normalizePythonName } from '../../src/policy/python-names.ts';

const format = (tool: typeof uv, key = 'lockfileFormat') => values(tool.extra?.[key] ?? { status: 'verified', value: {}, source: '', verifiedAt: '' })[0] as Record<string, unknown>;
const brief = (entries: { name: string; source: string; installScript: boolean | undefined; line?: number }[]) =>
  entries.map((entry) => [entry.name, entry.source, entry.installScript, entry.line]);

describe('Python package names', () => {
  it('are normalized as PEP 503 says', () => {
    expect(['Friendly.Bard', 'friendly_bard', 'FRIENDLY--bard', 'FrIeNdLy-._.-bArD'].map(normalizePythonName)).toEqual(Array(4).fill('friendly-bard'));
    expect(normalizePythonName('Acme_*')).toBe('acme-*');
  });
});

describe('uv.lock', () => {
  it('tells workspace members from other local directories, and wheels from source archives', () => {
    const lock = [
      'version = 1',
      '[[package]]',
      'name = "root"',
      'source = { virtual = "." }',
      '[[package]]',
      'name = "Member_Lib"',
      'source = { editable = "packages/member" }',
      '[[package]]',
      'name = "outside"',
      'source = { editable = "../outside" }',
      '[[package]]',
      'name = "archive"',
      'source = { path = "dist/archive-1.0.tar.gz" }',
      '[[package]]',
      'name = "wheel"',
      'source = { path = "dist/wheel-1.0-py3-none-any.whl" }',
      '[[package]]',
      'name = "odd"',
      'source = { somewhere = "x" }',
    ].join('\n');
    expect(brief(uvEntries(lock, format(uv), ['packages/member']))).toEqual([
      ['root', 'workspace', false, 2],
      ['member-lib', 'workspace', false, 5],
      ['outside', 'directory', true, 8],
      ['archive', 'file', true, 11],
      ['wheel', 'file', false, 14],
      ['odd', 'unknown', undefined, 17],
    ]);
  });

  it('is not fooled by a __proto__ key in a source', () => {
    const lock = ['version = 1', '[[package]]', 'name = "evil"', 'source = { __proto__ = { registry = "https://pypi.org/simple" }, git = "https://example.test/evil.git#abc" }'].join('\n');
    expect(brief(uvEntries(lock, format(uv), []))).toEqual([['evil', 'git', true, 2]]);
  });
});

describe('pylock.toml', () => {
  it('reads every kind of package entry', () => {
    const lock = [
      'lock-version = "1.0"',
      'created-by = "test"',
      '[[packages]]',
      'name = "from-index"',
      'index = "https://pypi.org/simple"',
      'wheels = [{ url = "https://files.example/from_index-1.0-py3-none-any.whl", hashes = { sha256 = "a" } }]',
      '[[packages]]',
      'name = "sdist-only"',
      'sdist = { url = "https://files.example/sdist-only-1.0.tar.gz", hashes = { sha256 = "b" } }',
      '[[packages]]',
      'name = "mercurial"',
      'vcs = { type = "hg", url = "https://hg.example/repo", commit-id = "c" }',
      '[[packages]]',
      'name = "local-wheel"',
      'archive = { path = "dist/local_wheel-1.0-py3-none-any.whl", hashes = { sha256 = "d" } }',
    ].join('\n');
    expect(brief(pylockEntries(lock, format(pip)))).toEqual([
      ['from-index', 'registry', false, 3],
      ['sdist-only', 'registry', true, 7],
      ['mercurial', 'unknown', true, 10],
      ['local-wheel', 'file', false, 13],
    ]);
  });
});

describe('requirements files', () => {
  const read = (text: string) => brief(requirementsEntries(text, requirementsFormatOf(pip)));

  it('reads registry, VCS, URL and path requirements with continuation lines, markers and comments', () => {
    const text = [
      '# comment',
      '--index-url https://pypi.org/simple',
      'Requests[socks]==2.32.0 ; python_version >= "3.9" # pinned',
      'idna==3.20 \\',
      '    --hash=sha256:aaaa',
      'demo @ git+ssh://git@example.test/demo.git@v1',
      'hg+https://hg.example.test/repo#egg=HgThing',
      'pkg@https://files.example.test/pkg-1.0-py3-none-any.whl',
      '--editable ./libs/local',
      'file:///opt/wheels/tool-2.0.tar.gz',
      '-e .',
      'git+https://example.test/unnamed.git',
      '',
    ].join('\n');
    expect(read(text)).toEqual([
      ['requests', 'registry', undefined, 3],
      ['idna', 'registry', undefined, 4],
      ['demo', 'git', true, 6],
      ['hgthing', 'unknown', true, 7],
      ['pkg', 'remoteTarball', false, 8],
      ['./libs/local', 'directory', true, 9],
      ['/opt/wheels/tool-2.0.tar.gz', 'file', true, 10],
      ['.', 'workspace', false, 11],
      ['git+https://example.test/unnamed.git', 'git', true, 12],
    ]);
    expect(requirementsEntries(text, requirementsFormatOf(pip)).at(-1)?.unnamed).toBe(true);
  });

  it('takes a requirement that looks like a path for a local path, and an archive name for a local archive, as pip does', () => {
    const text = ['libs/local-lib', 'vendor/thing-1.0.tar.xz', 'thing-2.0.tbz', 'tools\\helper', 'ftp://files.example.test/pkg-1.0.tar.gz', 'local_wheel-1.0-py3-none-any.whl', 'requests[socks]==2.32.0', ''].join('\n');
    expect(read(text)).toEqual([
      ['libs/local-lib', 'directory', true, 1],
      ['vendor/thing-1.0.tar.xz', 'file', true, 2],
      ['thing-2.0.tbz', 'file', true, 3],
      ['tools\\helper', 'directory', true, 4],
      ['ftp://files.example.test/pkg-1.0.tar.gz', 'remoteTarball', true, 5],
      ['local_wheel-1.0-py3-none-any.whl', 'file', false, 6],
      ['requests', 'registry', undefined, 7],
    ]);
  });

  it('lists the requirements and constraints files it includes, with their lines', () => {
    const text = ['-r base.txt', '--requirement=dev/extra.txt', '-c constraints.txt  # pinned', '--constraint more.txt', '-rshort.txt', 'requests==2.32.0', '--index-url https://pypi.org/simple', ''].join('\n');
    expect(requirementsIncludes(text, requirementsFormatOf(pip))).toEqual([
      { path: 'base.txt', line: 1 },
      { path: 'dev/extra.txt', line: 2 },
      { path: 'constraints.txt', line: 3 },
      { path: 'more.txt', line: 4 },
      { path: 'short.txt', line: 5 },
    ]);
  });
});

describe('writeRequirementsBlock', () => {
  const START = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead';
  const END = '# <<< depcurfew managed block';

  it('puts the options after the opening comments, comments out the same options elsewhere and is idempotent', () => {
    const before = '# generated\n--only-binary=:none:\nidna==3.20\n';
    const once = writeRequirementsBlock(before, ['--only-binary=:all:', '--no-binary=docopt'], ['--only-binary', '--no-binary']);
    expect(once).toBe(`# generated\n\n${START}\n--only-binary=:all:\n--no-binary=docopt\n${END}\n# depcurfew: superseded by the managed block: --only-binary=:none:\nidna==3.20\n`);
    expect(writeRequirementsBlock(once, ['--only-binary=:all:', '--no-binary=docopt'], ['--only-binary', '--no-binary'])).toBe(once);
    expect(writeRequirementsBlock(once, [], ['--only-binary', '--no-binary'])).toBe('# generated\n# depcurfew: superseded by the managed block: --only-binary=:none:\nidna==3.20\n');
  });

  it('leaves the file as it was when the block is removed again', () => {
    const before = '# header\nrequests==1\n';
    const once = writeRequirementsBlock(before, ['--only-binary=:all:'], ['--only-binary']);
    expect(writeRequirementsBlock(once, [], ['--only-binary'])).toBe(before);
    expect(writeRequirementsBlock(writeRequirementsBlock('requests==1\n', ['--only-binary=:all:'], ['--only-binary']), [], ['--only-binary'])).toBe('requests==1\n');
  });
});
