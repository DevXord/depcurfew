// Which Renovate packageRules entries cover every package of a registry (extra.packageRuleMatching), and the delay
// Renovate applies after the top level, presets and rules (extra.packageRulesOrder).
import { describe, expect, it } from 'vitest';
import { renovate } from '../../src/knowledge/renovate.ts';
import { readRenovateConfig, renovateDelay, ruleScope } from '../../src/doctor/renovate.ts';

const types = (rule: Record<string, unknown>, ecosystem: 'npm' | 'pypi' = 'npm') => ruleScope(renovate, rule, ecosystem)?.updateTypes;

describe('ruleScope', () => {
  it('covers every package without matchers, with "*" and with only negative name patterns', () => {
    expect(types({ minimumReleaseAge: null })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchPackageNames: ['*'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchDepNames: ['!@acme/*'] })).toEqual(['major', 'minor', 'patch']);
    expect(ruleScope(renovate, { matchPackageNames: ['!@acme/*', '!left-pad'] }, 'npm')?.names).toEqual({ kind: 'except', patterns: ['!@acme/*', '!left-pad'] });
  });

  it('does not cover every package when a positive name pattern narrows it', () => {
    expect(types({ matchPackageNames: ['@acme/*'] })).toBeUndefined();
    expect(types({ matchPackageNames: ['@acme/*', '!@acme/core'] })).toBeUndefined();
  });

  it('matches datasources like Renovate: globs, regexes and negation', () => {
    expect(types({ matchDatasources: ['npm'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchDatasources: ['NPM'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchDatasources: ['/^np/'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchDatasources: ['!pypi'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchDatasources: ['!pypi'] }, 'pypi')).toBeUndefined();
    expect(types({ matchDatasources: ['!/^py/'] }, 'pypi')).toBeUndefined();
    expect(types({ matchDatasources: ['pypi'] })).toBeUndefined();
  });

  it('leaves glob syntax it does not evaluate to the narrow side', () => {
    expect(types({ matchDatasources: ['{npm,pypi}'] })).toBeUndefined();
    expect(types({ matchDatasources: ['/[/'] })).toBeUndefined();
  });

  it('keeps only the delayed update types a rule names', () => {
    expect(types({ matchUpdateTypes: ['major', 'minor', 'patch'] })).toEqual(['major', 'minor', 'patch']);
    expect(types({ matchUpdateTypes: ['!major'] })).toEqual(['minor', 'patch']);
    expect(types({ matchUpdateTypes: ['pin', 'digest', 'lockFileMaintenance'] })).toBeUndefined();
  });

  it('treats other matchers as exceptions for some packages', () => {
    expect(types({ matchDepTypes: ['devDependencies'] })).toBeUndefined();
    expect(types({ matchManagers: ['npm'] })).toBeUndefined();
    expect(types({ matchFileNames: ['packages/**'] })).toBeUndefined();
  });
});

describe('renovateDelay', () => {
  const delay = (config: unknown, ecosystem: 'npm' | 'pypi' = 'npm') => {
    const result = renovateDelay(renovate, readRenovateConfig(JSON.stringify(config, null, 2), 'renovate.json', []), ecosystem);
    return result.known ? Object.fromEntries([...result.byType].map(([type, source]) => [type, source.value])) : result;
  };

  it('applies preset rules over the top level and repository rules after them', () => {
    expect(delay({ extends: ['config:best-practices'], minimumReleaseAge: '1 day' })).toEqual({ major: '3 days', minor: '3 days', patch: '3 days' });
    expect(delay({ extends: ['config:best-practices'], minimumReleaseAge: '1 day' }, 'pypi')).toEqual({ major: '1 day', minor: '1 day', patch: '1 day' });
    expect(delay({ extends: ['config:best-practices'], packageRules: [{ matchUpdateTypes: ['patch'], minimumReleaseAge: '1 hour' }] })).toEqual({
      major: '3 days',
      minor: '3 days',
      patch: '1 hour',
    });
  });

  it('has no delay for a type nothing sets', () => {
    expect(delay({ extends: ['config:recommended'], packageRules: [{ matchUpdateTypes: ['major'], minimumReleaseAge: '7 days' }] })).toEqual({ major: '7 days' });
  });

  it('cannot tell when an unreadable preset may set it and the repository does not', () => {
    expect(delay({ extends: ['config:recommended', 'github>acme/renovate-config'] })).toEqual({ known: false, preset: 'github>acme/renovate-config', line: 2 });
    expect(delay({ extends: ['github>acme/renovate-config'], packageRules: [{ matchDatasources: ['npm'], minimumReleaseAge: '3 days' }] })).toEqual({
      major: '3 days',
      minor: '3 days',
      patch: '3 days',
    });
    expect(delay({ extends: ['config:best-practices', 'local>acme/presets'] })).toEqual({ major: '3 days', minor: '3 days', patch: '3 days' });
    expect(delay({ extends: ['config:best-practices', 'local>acme/presets'] }, 'pypi')).toEqual({ known: false, preset: 'local>acme/presets', line: 2 });
  });
});
