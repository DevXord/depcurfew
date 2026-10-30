import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { writeRequirementsBlock } from '../../src/apply/pip-requirements.ts';
import { pdmEntries, pipfileLockEntries, pylockEntries, requirementsEntries, requirementsFormatOf, requirementsIncludes, uvEntries } from '../../src/doctor/python-lockfiles.ts';
import { pdm } from '../../src/knowledge/pdm.ts';
import { pipenv } from '../../src/knowledge/pipenv.ts';
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

describe('pdm.lock', () => {
  it('tells index packages with and without wheels from VCS, URL and local packages', () => {
    const lock = [
      '[metadata]',
      'lock_version = "4.5.1"',
      '[[package]]',
      'name = "idna"',
      'version = "3.10"',
      'files = [',
      '    {file = "idna-3.10-py3-none-any.whl", hash = "sha256:aa"},',
      '    {file = "idna-3.10.tar.gz", hash = "sha256:bb"},',
      ']',
      '[[package]]',
      'name = "Docopt"',
      'version = "0.6.2"',
      'files = [{file = "docopt-0.6.2.tar.gz", hash = "sha256:cc"}]',
      '[[package]]',
      'name = "sampleproject"',
      'version = "4.0.0"',
      'git = "https://github.com/pypa/sampleproject"',
      'revision = "621e4974"',
      '[[package]]',
      'name = "mercurial-thing"',
      'version = "1.0"',
      'hg = "https://hg.example.test/thing"',
      '[[package]]',
      'name = "remote"',
      'version = "1.0"',
      'url = "https://example.test/remote-1.0-py3-none-any.whl"',
      '[[package]]',
      'name = "local"',
      'version = "0.1.0"',
      'path = "./libs/local"',
      'editable = true',
      '[[package]]',
      'name = "archive"',
      'version = "1.0"',
      'path = "dist/archive-1.0.tar.gz"',
    ].join('\n');
    expect(brief(pdmEntries(lock, format(pdm)))).toEqual([
      ['idna', 'registry', false, 3],
      ['docopt', 'registry', true, 10],
      ['sampleproject', 'git', true, 14],
      ['mercurial-thing', 'unknown', true, 19],
      ['remote', 'remoteTarball', false, 23],
      ['local', 'directory', true, 27],
      ['archive', 'file', true, 32],
    ]);
  });
});

describe('Pipfile.lock', () => {
  it('reads every category and tells git, URL and local packages from index packages', () => {
    const lock = JSON.stringify(
      {
        _meta: { 'pipfile-spec': 6, sources: [{ name: 'pypi', url: 'https://pypi.org/simple' }] },
        default: {
          idna: { hashes: ['sha256:aa', 'sha256:bb'], index: 'pypi', version: '==3.10' },
          sampleproject: { git: 'https://github.com/pypa/sampleproject', ref: '621e4974' },
          remote: { file: 'https://example.test/remote-1.0.tar.gz' },
        },
        develop: { 'Local_Lib': { editable: true, path: './libs/local-lib' } },
        docs: { sphinx: { version: '==8.0.0', index: 'pypi' } },
      },
      null,
      4,
    );
    expect(brief(pipfileLockEntries(lock, format(pipenv))).map(([name, source, builds]) => [name, source, builds])).toEqual([
      ['idna', 'registry', undefined],
      ['sampleproject', 'git', true],
      ['remote', 'remoteTarball', true],
      ['local-lib', 'directory', true],
      ['sphinx', 'registry', undefined],
    ]);
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

describe('the project itself in a lockfile', () => {
  it('is part of the workspace in Pipfile.lock (pipenv install -e .), not a local directory', () => {
    const lock = JSON.stringify({
      _meta: { sources: [] },
      default: { myapp: { editable: true, path: '.' }, other: { path: './' }, 'local-lib': { editable: true, path: './libs/local-lib' } },
    });
    expect(brief(pipfileLockEntries(lock, format(pipenv))).map(([name, source, builds]) => [name, source, builds])).toEqual([
      ['myapp', 'workspace', false],
      ['other', 'workspace', false],
      ['local-lib', 'directory', true],
    ]);
  });

  it('is part of the workspace in pylock.toml, like workspace members; other directories are built', () => {
    const lock = [
      'lock-version = "1.0"',
      'created-by = "uv"',
      '[[packages]]',
      'name = "myapp"',
      'directory = { path = ".", editable = true }',
      '[[packages]]',
      'name = "member"',
      'directory = { path = "./packages/member/", editable = true }',
      '[[packages]]',
      'name = "vendored"',
      'directory = { path = "vendor/vendored" }',
    ].join('\n');
    expect(brief(pylockEntries(lock, format(pip), ['packages/member']))).toEqual([
      ['myapp', 'workspace', false, 3],
      ['member', 'workspace', false, 6],
      ['vendored', 'directory', true, 9],
    ]);
  });
});
