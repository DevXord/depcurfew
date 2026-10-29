import { describe, expect, it } from 'vitest';
import { describeRequirements, listing } from '../../src/apply/requirements.ts';

describe('describeRequirements', () => {
  it('groups settings by the version that added them, oldest first', () => {
    expect(
      describeRequirements([
        { setting: 'allowScripts', since: '11.16.0' },
        { setting: 'min-release-age', since: '11.10.0' },
        { setting: 'allow-git', since: '11.10.0' },
        { setting: 'allow-file', since: '11.15.0' },
      ]),
    ).toBe('min-release-age and allow-git (since 11.10.0), allow-file (since 11.15.0), allowScripts (since 11.16.0)');
  });

  it('says once, at the end, that disputed versions are read the safer way', () => {
    expect(
      describeRequirements([
        { setting: 'min-release-age', since: '11.10.0', disputed: true },
        { setting: 'allow-file', since: '11.15.0', disputed: true },
        { setting: 'allowScripts', since: '11.16.0' },
      ]),
    ).toBe(
      'min-release-age (since 11.10.0), allow-file (since 11.15.0), allowScripts (since 11.16.0); where official sources disagree on the version, depgate assumes the later one',
    );
  });

  it('lists items like a sentence', () => {
    expect(listing(['a'])).toBe('a');
    expect(listing(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
