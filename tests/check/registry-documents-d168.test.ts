// Package documents of the npm registry as large as real ones (decision D-168): renovate's was 74,150,801 bytes on
// 2026-11-03, so the limit is 256 MiB, and the document is read as it streams in, keeping only what the check uses
// (dist-tags, time, and of each version its install scripts and deprecated), so memory stays far below its size. A
// document over the limit says so, with a fix that is not about an unreachable registry. The PyPI page of a project
// reads the version of every file name in time linear in its length.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSpec } from '../../src/check/index.ts';
import { fileVersion } from '../../src/check/pypi.ts';
import { fetchPackument, MAX_DOCUMENT_SIZE, type FetchLike } from '../../src/check/registry.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { normalizePythonName } from '../../src/policy/python-names.ts';
import { parseVersion } from '../../src/check/pep440.ts';
import { policy } from './support.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const REGISTRY = 'https://registry.npmjs.org/';

function answering(body: string | Uint8Array, headers: Record<string, string> = {}): FetchLike {
  return async () => new Response(body, { status: 200, headers });
}

/** A stream of `count` chunks of `size` bytes of one character. */
function streamed(count: number, size: number): FetchLike {
  return async () => {
    let sent = 0;
    const chunk = new Uint8Array(size).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < count) controller.enqueue(chunk);
        else controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
}

describe('the package document of the npm registry', () => {
  it('is read up to 256 MiB', () => {
    expect(MAX_DOCUMENT_SIZE).toBe(256 * 1024 * 1024);
  });

  it('checks a document of 65 MiB, larger than the old limit, and keeps none of its readme', async () => {
    const body = JSON.stringify({
      name: 'big',
      'dist-tags': { latest: '1.0.0' },
      time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': { name: 'big', version: '1.0.0', readme: 'y'.repeat(1024), scripts: { test: 'x', postinstall: 'node x.js' }, deprecated: 'use small' } },
      readme: 'x'.repeat(65 * 1024 * 1024),
    });
    const lookup = await fetchPackument('big', { registry: REGISTRY, fetch: answering(body) });
    expect(lookup).toEqual({
      status: 'found',
      packument: {
        name: 'big',
        distTags: { latest: '1.0.0' },
        time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
        versions: { '1.0.0': { version: '1.0.0', scripts: { postinstall: 'node x.js' }, deprecated: 'use small' } },
      },
    });
  }, 60_000);

  it('reads every recorded document as JSON.parse reads it', async () => {
    const directory = new URL('../fixtures/registry/', import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'recorded.json')) {
      const text = readFileSync(new URL(file, directory), 'utf8');
      const document = JSON.parse(text) as Record<string, unknown> & { status?: number };
      if (typeof document.status === 'number') continue;
      const lookup = await fetchPackument(String(document['name']), { registry: REGISTRY, fetch: answering(text) });
      expect(lookup.status).toBe('found');
      if (lookup.status !== 'found') continue;
      const versions = document['versions'] as Record<string, { scripts?: Record<string, unknown>; deprecated?: unknown }>;
      expect(Object.keys(lookup.packument.versions)).toEqual(Object.keys(versions));
      expect(lookup.packument.distTags).toEqual(document['dist-tags']);
      expect(lookup.packument.time).toEqual(document['time']);
      for (const [version, entry] of Object.entries(versions)) {
        expect(lookup.packument.versions[version]?.deprecated).toEqual(entry.deprecated);
        for (const script of ['preinstall', 'install', 'postinstall']) expect(lookup.packument.versions[version]?.scripts?.[script]).toEqual(entry.scripts?.[script]);
      }
    }
  });

  it('reads keys with escapes, the last of two equal keys and a byte order mark as JSON.parse does', async () => {
    const text = '﻿{"name":"esc","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{"scripts":{"postinstall":"old"}}},"vers\\u0069ons":{"1.0.0":{"scr\\u0069pts":{"post\\u0069nstall":"a \\"b\\" \\u00e9"},"deprecated":false}},"time":{"1.0.0":"2020-01-01T00:00:00.000Z"},"time":{"1.0.0":"2021-01-01T00:00:00.000Z"}}';
    const lookup = await fetchPackument('esc', { registry: REGISTRY, fetch: answering(text) });
    expect(lookup).toEqual({
      status: 'found',
      packument: { name: 'esc', distTags: { latest: '1.0.0' }, time: { '1.0.0': '2021-01-01T00:00:00.000Z' }, versions: { '1.0.0': { version: '1.0.0', scripts: { postinstall: 'a "b" é' }, deprecated: false } } },
    });
  });

  it('refuses what is not a JSON object, also when the broken part is one depcurfew skips', async () => {
    for (const text of ['<html>Bad gateway</html>', '[]', '"x"', '{"name":"x","readme":"unterminated', '{"name":"x","readme":tru}', '{"name":"x"} trailing', '{"name":"x",}', '{"a":01}', '{"a":"\u0001"}']) {
      expect(await fetchPackument('x', { registry: REGISTRY, fetch: answering(text) })).toEqual({ status: 'error', reason: 'the registry answered something that is not a package document' });
    }
  });

  it('says that a document over the limit is larger than depcurfew reads, with a fix to check the package by hand', async () => {
    const declared = await fetchPackument('renovate', { registry: REGISTRY, fetch: answering('{}', { 'content-length': String(MAX_DOCUMENT_SIZE + 1) }) });
    expect(declared).toEqual({
      status: 'error',
      reason: 'the registry document of renovate is larger than 256 MiB, more than depcurfew reads of one package',
      fix: 'Check renovate by hand before installing it: its versions, when they were published and their install scripts',
    });
    // Without a content-length, the stream is cut off at the limit.
    const stream = await fetchPackument('renovate', { registry: REGISTRY, fetch: streamed(20, 1024 * 1024), maxBytes: 4 * 1024 * 1024 });
    expect(stream).toMatchObject({ status: 'error', reason: 'the registry document of renovate is larger than 4 MiB, more than depcurfew reads of one package' });
  });

  it('gives check the fix for a document over the limit', async () => {
    const report = await checkSpec('renovate', {
      policy: policy({}),
      fetch: answering('{}', { 'content-length': String(MAX_DOCUMENT_SIZE + 1) }),
      now: NOW,
      registry: REGISTRY,
      popular: new PopularNames([]),
    });
    expect(report.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'it cannot be checked: the registry document of renovate is larger than 256 MiB, more than depcurfew reads of one package',
        fix: 'Check renovate by hand before installing it: its versions, when they were published and their install scripts',
      },
    ]);
  });
});

describe('the version of a file on a PyPI page', () => {
  /** fileVersion of 1.5.0, which normalized the name before every dash. */
  function quadratic(filename: string, name: string): { version: string; kind: 'wheel' | 'sdist' } | undefined {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.whl')) {
      const parts = filename.slice(0, -4).split('-');
      if (parts.length < 5 || parts.length > 6 || normalizePythonName(parts[0] ?? '') !== name) return undefined;
      return { version: parts[1] ?? '', kind: 'wheel' };
    }
    const extension = ['.tar.gz', '.zip'].find((candidate) => lower.endsWith(candidate));
    if (extension === undefined) return undefined;
    const stem = filename.slice(0, -extension.length);
    for (let dash = stem.indexOf('-'); dash !== -1; dash = stem.indexOf('-', dash + 1)) {
      if (normalizePythonName(stem.slice(0, dash)) === name && parseVersion(stem.slice(dash + 1)) !== undefined) return { version: stem.slice(dash + 1), kind: 'sdist' };
    }
    return undefined;
  }

  it('reads a name of 8000 dashes, or of 16000 parts, in well under a second', () => {
    for (const filename of [`requests${'-a'.repeat(8000)}.tar.gz`, `${'a-'.repeat(16_000)}1.0.tar.gz`, `${'-'.repeat(32_000)}1.0.tar.gz`, `${'a._-'.repeat(8000)}1.0.zip`]) {
      const start = performance.now();
      fileVersion(filename, 'requests');
      fileVersion(filename, normalizePythonName(filename.slice(0, 2000)));
      expect(performance.now() - start).toBeLessThan(250);
    }
  });

  it('gives what the quadratic reading gave', () => {
    const names = ['foo', 'foo-bar', 'foo-bar-baz', 'a', 'i-u0307', 'ss'];
    const stems = ['foo-1.0', 'Foo_Bar-2.0', 'foo.bar--3.0', 'foo-bar-baz-1.0.post1', 'foo--bar-1', 'foo-_-1.0', 'foo-bar-v1.0', 'foo- 1.0', 'İ-1.0', 'ß-1.0', 'Σ-1', 'foo-bar-', '-1.0', 'foo-bar-1.0-2.0', 'a-a-a-1', 'a_-a-1', 'foo-1.0-foo-2.0', 'x-y-z'];
    for (const name of names) {
      for (const stem of stems) {
        for (const extension of ['.tar.gz', '.zip', '.whl']) {
          const filename = extension === '.whl' ? `${stem}-py3-none-any.whl` : `${stem}${extension}`;
          expect({ filename, name, found: fileVersion(filename, name) }).toEqual({ filename, name, found: quadratic(filename, name) });
        }
      }
    }
  });
});
