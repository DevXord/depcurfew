import { describe, expect, it } from 'vitest';
import { parsePythonSpec } from '../../src/check/python-spec.ts';

const clauses = (text: string) => {
  const spec = parsePythonSpec(text);
  return spec?.kind === 'registry' ? spec.clauses?.map((clause) => `${clause.operator}${clause.version}${clause.wildcard ? '.*' : ''}`).join(',') : spec?.kind;
};

describe('parsePythonSpec: registry requirements', () => {
  it.each([
    ['requests', 'requests', ''],
    ['Requests>=2.0,<3', 'requests', '>=2.0,<3'],
    ['requests[security,socks]==2.31.0', 'requests', '==2.31.0'],
    ['requests (>=2.0)', 'requests', '>=2.0'],
    ['requests >= 2.0 , < 3', 'requests', '>=2.0,<3'],
    ['requests==2.31.0; python_version > "3.8"', 'requests', '==2.31.0'],
    ['zope.interface~=6.0', 'zope-interface', '~=6.0'],
    ['legacy===foobar', 'legacy', '===foobar'],
    ['Django==4.2.*', 'django', '==4.2.*'],
  ])('%s', (text, name, expected) => {
    const spec = parsePythonSpec(text);
    expect(spec?.kind).toBe('registry');
    expect(spec?.name).toBe(name);
    expect(clauses(text)).toBe(expected);
  });

  it('reads name@version and name@latest, as uv tool commands and Poetry write them', () => {
    expect(clauses('ruff@0.6.0')).toBe('==0.6.0');
    expect(parsePythonSpec('ruff@latest')).toMatchObject({ kind: 'registry', name: 'ruff', clauses: [], latest: true });
  });

  it.each([
    // Poetry's caret, tilde and wildcard constraints.
    ['demo@^1.2.3', '>=1.2.3,<2.0.0'],
    ['demo@^1.2', '>=1.2.0,<2.0.0'],
    ['demo@^1', '>=1.0.0,<2.0.0'],
    ['demo@^0.2.3', '>=0.2.3,<0.3.0'],
    ['demo@^0.0.3', '>=0.0.3,<0.0.4'],
    ['demo@^0.0', '>=0.0.0,<0.1.0'],
    ['demo@^0', '>=0.0.0,<1.0.0'],
    ['demo@~1.2.3', '>=1.2.3,<1.3.0'],
    ['demo@~1.2', '>=1.2.0,<1.3.0'],
    ['demo@~1', '>=1.0.0,<2.0.0'],
    ['demo@*', ''],
    ['demo@1.*', '>=1.0.0,<2.0.0'],
    ['demo@1.2.*', '>=1.2.0,<1.3.0'],
    ['demo@>=1.2,<1.5', '>=1.2,<1.5'],
    ['demo@==1.2.3', '==1.2.3'],
    ['demo@!=1.2.3', '!=1.2.3'],
    ['demo@~=1.2', '~=1.2'],
  ])('%s', (text, expected) => {
    expect(clauses(text)).toBe(expected);
  });

  it.each(['', '>=2', 'requests>=', 'requests==', '@scope', 'requests[', 'demo@^x', 'demo@1.2||2.0', 'requests 2.0'])('rejects %j', (text) => {
    expect(parsePythonSpec(text)).toBeUndefined();
  });
});

describe('parsePythonSpec: other sources', () => {
  it.each([
    ['requests @ https://example.com/requests-2.0.tar.gz', 'remoteTarball', 'requests'],
    ['requests@git+https://github.com/psf/requests', 'git', 'requests'],
    ['git+https://github.com/psf/requests.git#egg=requests', 'git', 'requests'],
    ['git+ssh://git@github.com/psf/requests.git', 'git', undefined],
    ['https://example.com/demo-1.0-py3-none-any.whl', 'remoteTarball', undefined],
    ['./lib', 'directory', undefined],
    ['lib/', 'directory', undefined],
    ['dist/demo-1.0-py3-none-any.whl', 'file', undefined],
    ['demo-1.0.tar.gz', 'file', undefined],
    ['file:///tmp/demo', 'directory', undefined],
    ['.', 'workspace', undefined],
  ])('%s', (text, kind, name) => {
    const spec = parsePythonSpec(text);
    expect(spec?.kind).toBe(kind);
    expect(spec?.name).toBe(name);
  });

  it('takes the value of -e for a path even without a separator', () => {
    expect(parsePythonSpec('mylib', { editable: true })?.kind).toBe('directory');
    expect(parsePythonSpec('mylib')?.kind).toBe('registry');
  });

  it('does not look up other version control systems', () => {
    expect(parsePythonSpec('hg+https://hg.example.com/demo')).toMatchObject({ kind: 'other' });
    expect(parsePythonSpec('hg+https://hg.example.com/demo')?.reason).toMatch(/hg\+/u);
  });
});
