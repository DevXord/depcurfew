import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('blocks fetch', async () => {
    await expect(fetch('https://registry.npmjs.org/depgate')).rejects.toThrow(/Network access is disabled/);
  });

  it('blocks raw sockets', () => {
    expect(() => net.connect(443, 'registry.npmjs.org')).toThrow(/Network access is disabled/);
    expect(() => new net.Socket().connect(443, 'registry.npmjs.org')).toThrow(/Network access is disabled/);
  });

  it('blocks http and https clients', () => {
    expect(() => http.get('http://example.com')).toThrow(/Network access is disabled/);
    expect(() => https.request('https://example.com')).toThrow(/Network access is disabled/);
  });
});
