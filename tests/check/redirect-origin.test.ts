// Redirects that leave the origin (decision D-082): the message says what changed, the scheme, the port or the host.
import { describe, expect, it } from 'vitest';
import { fetchSameOrigin, type FetchLike } from '../../src/check/registry.ts';

const redirectTo = (location: string): FetchLike => async () => new Response(null, { status: 301, headers: { location } });
const init = { headers: {}, signal: new AbortController().signal };

describe('a redirect out of the origin', () => {
  it('names a move from http to https on the same host as such, and says to use https', async () => {
    expect(await fetchSameOrigin('http://registry.example/left-pad', init, redirectTo('https://registry.example/left-pad'), 'registry')).toEqual({
      reason: 'the registry redirected to https://registry.example, the same host over https instead of http, which depcurfew does not follow, as it follows redirects only within one origin',
      fix: 'Use https://registry.example in the registry URL if you trust it, so that depcurfew asks it directly',
    });
  });

  it('names another port of the same host', async () => {
    expect(await fetchSameOrigin('https://registry.example/left-pad', init, redirectTo('https://registry.example:8443/left-pad'), 'index')).toEqual({
      reason: 'the index redirected to https://registry.example:8443, another port of the same host, which depcurfew does not follow, as it follows redirects only within one origin',
      fix: 'Use https://registry.example:8443 in the index URL if you trust it, so that depcurfew asks it directly',
    });
  });

  it('keeps calling another host another host', async () => {
    expect(await fetchSameOrigin('http://registry.example/left-pad', init, redirectTo('https://evil.example/left-pad'), 'registry')).toEqual({
      reason: 'the registry redirected to https://evil.example, another host, which depcurfew does not follow: that host could answer for any package',
      fix: 'Set the registry URL to the host that serves the packages if you trust it, or check the package there yourself before installing it',
    });
  });
});
