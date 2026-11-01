// The signal of one registry lookup: the time limit and the caller's signal (a cancelled call of depcurfew mcp).
// AbortSignal.any arrived in Node.js 20.3 and 18.17, and depcurfew runs from 18.3.0 (decision D-103), so the two are
// combined by hand where it is missing.
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPackument, requestSignal, type FetchLike } from '../../src/check/registry.ts';

const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

/** Runs the test as on a Node.js without AbortSignal.any. */
function withoutAny(): void {
  Reflect.deleteProperty(AbortSignal, 'any');
  expect('any' in AbortSignal).toBe(false);
}

afterEach(() => {
  if (original !== undefined) Object.defineProperty(AbortSignal, 'any', original);
});

const aborted = (signal: AbortSignal) => new Promise<unknown>((resolve) => signal.addEventListener('abort', () => resolve(signal.reason), { once: true }));

describe.each([
  ['with AbortSignal.any', () => undefined],
  ['without AbortSignal.any', withoutAny],
])('requestSignal %s', (_name, setUp) => {
  it('aborts with the reason of the caller', async () => {
    setUp();
    const caller = new AbortController();
    const signal = requestSignal(60_000, caller.signal);
    expect(signal.aborted).toBe(false);
    const reason = new Error('cancelled');
    caller.abort(reason);
    // The caller's abort reaches the lookup at once, with its reason.
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it('aborts with a TimeoutError when the time is up', async () => {
    setUp();
    const signal = requestSignal(5, new AbortController().signal);
    const reason = await aborted(signal);
    expect((reason as Error).name).toBe('TimeoutError');
  });

  it('is aborted at once for a caller that already aborted', () => {
    setUp();
    const caller = new AbortController();
    caller.abort(new Error('gone'));
    const signal = requestSignal(60_000, caller.signal);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe('gone');
  });

  it('lets a lookup run and be cancelled', async () => {
    setUp();
    const caller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason as Error), { once: true });
        caller.abort(new Error('cancelled by the client'));
      });
    const lookup = await fetchPackument('lodash', { registry: 'https://registry.npmjs.org/', fetch, signal: caller.signal });
    expect(lookup).toEqual({ status: 'error', reason: 'the registry cannot be reached (cancelled by the client)' });
  });
});
