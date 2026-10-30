import { describe, expect, it } from 'vitest';
import { fetchProject, fileVersion, projectUrl, type PypiProject } from '../../src/check/pypi.ts';
import type { FetchLike } from '../../src/check/registry.ts';

const INDEX = 'https://pypi.org/simple/';

function answer(status: number, body: unknown): FetchLike {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

async function project(body: unknown): Promise<PypiProject> {
  const lookup = await fetchProject('Demo_Pkg', { index: INDEX, fetch: answer(200, body) });
  if (lookup.status !== 'found') throw new Error(JSON.stringify(lookup));
  return lookup.project;
}

describe('projectUrl', () => {
  it('uses the normalized name with a trailing slash', () => {
    expect(projectUrl(INDEX, 'Friendly.Bard')).toBe('https://pypi.org/simple/friendly-bard/');
    expect(projectUrl('https://example.org/simple', 'a_b')).toBe('https://example.org/simple/a-b/');
  });
});

describe('fileVersion', () => {
  it.each([
    ['demo_pkg-1.0-py3-none-any.whl', { version: '1.0', kind: 'wheel' }],
    ['demo_pkg-1.0-1-cp312-cp312-manylinux_2_17_x86_64.whl', { version: '1.0', kind: 'wheel' }],
    ['Demo.Pkg-2.0.tar.gz', { version: '2.0', kind: 'sdist' }],
    ['demo-pkg-2.0rc1.zip', { version: '2.0rc1', kind: 'sdist' }],
    ['demo_pkg-3.0.TAR.GZ', { version: '3.0', kind: 'sdist' }],
  ])('%s', (filename, expected) => {
    expect(fileVersion(filename, 'demo-pkg')).toEqual(expected);
  });

  it.each(['demo_pkg-1.0-py2.4.egg', 'demo_pkg-1.0.win32.exe', 'other-1.0.tar.gz', 'demo_pkg.tar.gz', 'demo_pkg-1.0.whl'])('ignores %s', (filename) => {
    expect(fileVersion(filename, 'demo-pkg')).toBeUndefined();
  });
});

describe('fetchProject', () => {
  it('groups the files by version', async () => {
    const found = await project({
      name: 'demo-pkg',
      versions: ['1.0', '1.1', '2.0'],
      files: [
        { filename: 'demo_pkg-1.0.tar.gz', 'upload-time': '2024-01-01T00:00:00.000000Z', yanked: false },
        { filename: 'demo_pkg-1.0-py3-none-any.whl', 'upload-time': '2024-01-02T00:00:00Z', yanked: false },
        { filename: 'demo_pkg-1.1.tar.gz', 'upload-time': '2024-02-01T00:00:00Z', yanked: 'Broken build' },
        { filename: 'demo_pkg-1.1-py2.4.egg', 'upload-time': '2024-02-01T00:00:00Z' },
      ],
      meta: { 'api-version': '1.4' },
    });
    expect(found.name).toBe('demo-pkg');
    expect(found.status).toBe('active');
    expect([...found.releases.keys()]).toEqual(['1.0', '1.1']);
    expect(found.releases.get('1.0')).toEqual([
      { filename: 'demo_pkg-1.0.tar.gz', kind: 'sdist', uploadedAt: '2024-01-01T00:00:00.000000Z', yanked: false },
      { filename: 'demo_pkg-1.0-py3-none-any.whl', kind: 'wheel', uploadedAt: '2024-01-02T00:00:00Z', yanked: false },
    ]);
    expect(found.releases.get('1.1')).toEqual([{ filename: 'demo_pkg-1.1.tar.gz', kind: 'sdist', uploadedAt: '2024-02-01T00:00:00Z', yanked: 'Broken build' }]);
  });

  it('keeps the version as the index lists it', async () => {
    const found = await project({ name: 'demo-pkg', versions: ['1.0.0'], files: [{ filename: 'demo_pkg-1.0-py3-none-any.whl' }] });
    expect([...found.releases.keys()]).toEqual(['1.0.0']);
    expect(found.releases.get('1.0.0')?.[0]?.uploadedAt).toBeUndefined();
  });

  it('reads the project status and its reason', async () => {
    const found = await project({ name: 'demo-pkg', versions: [], files: [], 'project-status': { status: 'quarantined', reason: 'malware' } });
    expect(found.status).toBe('quarantined');
    expect(found.statusReason).toBe('malware');
  });

  it('a name the index does not know is not found', async () => {
    expect(await fetchProject('nope', { index: INDEX, fetch: answer(404, 'Not Found') })).toEqual({ status: 'not-found' });
  });

  it('other answers and broken documents are errors', async () => {
    expect(await fetchProject('x', { index: INDEX, fetch: answer(503, 'down') })).toEqual({ status: 'error', reason: 'the index answered HTTP 503' });
    expect((await fetchProject('x', { index: INDEX, fetch: answer(200, '<html>') })).status).toBe('error');
    expect(await fetchProject('x', { index: INDEX, fetch: answer(200, { name: 'x' }) })).toEqual({ status: 'error', reason: 'the index answered something that is not a project page' });
    const failing: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    expect(await fetchProject('x', { index: INDEX, fetch: failing })).toEqual({ status: 'error', reason: 'the index cannot be reached (getaddrinfo ENOTFOUND)' });
  });

  it('asks for the JSON form', async () => {
    let headers: Record<string, string> = {};
    const capture: FetchLike = async (_url, init) => {
      headers = init.headers;
      return new Response('{"name":"x","versions":[],"files":[]}', { status: 200 });
    };
    await fetchProject('x', { index: INDEX, fetch: capture });
    expect(headers['accept']).toBe('application/vnd.pypi.simple.v1+json');
  });
});
