// Which Renovate packageRules entries cover every package of a registry (extra.packageRuleMatching), and the delay
// Renovate applies after the top level, presets and rules (extra.packageRulesOrder).
import { describe, expect, it } from 'vitest';
import { renovate } from '../../src/knowledge/renovate.ts';
import { actionsTarget, managerTarget, readRenovateConfig, renovateDelay, ruleCoverage, ruleScope, type RenovateTarget } from '../../src/doctor/renovate.ts';

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
    expect(types({ matchFileNames: ['packages/**'] })).toBeUndefined();
    // Without a Renovate manager (a registry alone), a rule for some managers covers only part of it.
    expect(types({ matchManagers: ['npm'] })).toBeUndefined();
  });
});

describe('ruleScope with Renovate managers and categories (D-131)', () => {
  const npm = managerTarget(renovate, 'npm', 'npm');
  const pnpm = managerTarget(renovate, 'pnpm', 'npm');
  const bun = managerTarget(renovate, 'bun', 'npm');
  const uv = managerTarget(renovate, 'uv', 'pypi');
  const pip = managerTarget(renovate, 'pip', 'pypi');
  const poetry = managerTarget(renovate, 'poetry', 'pypi');
  const actions = actionsTarget(renovate);
  const covers = (rule: Record<string, unknown>, target: RenovateTarget | undefined) => (target === undefined ? undefined : ruleScope(renovate, rule, target)?.updateTypes);
  const all = ['major', 'minor', 'patch'];

  it('knows the manager, datasource and categories of each tool and of the actions of workflows', () => {
    expect(npm).toEqual({ datasource: 'npm', manager: 'npm', categories: ['js'] });
    expect(pnpm).toEqual(npm);
    expect(bun).toEqual({ datasource: 'npm', manager: 'bun', categories: ['js'] });
    expect(uv).toEqual({ datasource: 'pypi', manager: 'pep621', categories: ['python'] });
    expect(poetry).toEqual({ datasource: 'pypi', manager: 'poetry', categories: ['python'] });
    expect(actions).toEqual({ datasource: 'github-tags', manager: 'github-actions', categories: ['ci'], actions: true, files: [], depTypes: ['action'] });
    expect(actionsTarget(renovate, ['.github/workflows/ci.yml'])?.files).toEqual(['.github/workflows/ci.yml']);
  });

  it('matches matchManagers like Renovate: names, globs, regexes, negation and a single string', () => {
    expect(covers({ matchManagers: ['npm'] }, npm)).toEqual(all);
    expect(covers({ matchManagers: ['npm'] }, pnpm)).toEqual(all);
    expect(covers({ matchManagers: ['npm'] }, bun)).toBeUndefined();
    expect(covers({ matchManagers: 'npm' }, npm)).toEqual(all);
    expect(covers({ matchManagers: ['NPM'] }, npm)).toEqual(all);
    expect(covers({ matchManagers: ['pip*'] }, pip)).toEqual(all);
    expect(covers({ matchManagers: ['/^pep/'] }, uv)).toEqual(all);
    expect(covers({ matchManagers: ['!npm'] }, bun)).toEqual(all);
    expect(covers({ matchManagers: ['!npm'] }, npm)).toBeUndefined();
    expect(covers({ matchManagers: ['*'] }, actions)).toEqual(all);
    expect(covers({ matchManagers: ['github-actions'] }, actions)).toEqual(all);
    expect(covers({ matchManagers: ['github-actions'] }, npm)).toBeUndefined();
  });

  it('never matches a custom manager name for a built-in manager', () => {
    expect(covers({ matchManagers: ['custom.regex'] }, npm)).toBeUndefined();
    expect(covers({ matchManagers: ['!custom.regex'] }, npm)).toEqual(all);
  });

  it('matches matchCategories when any category of the manager matches', () => {
    expect(covers({ matchCategories: ['js'] }, bun)).toEqual(all);
    expect(covers({ matchCategories: ['python', 'js'] }, npm)).toEqual(all);
    expect(covers({ matchCategories: ['js'] }, uv)).toBeUndefined();
    expect(covers({ matchCategories: 'python' }, poetry)).toEqual(all);
    expect(covers({ matchCategories: ['ci'] }, actions)).toEqual(all);
    expect(covers({ matchCategories: ['!js'] }, actions)).toEqual(all);
  });

  it('needs every matcher to match', () => {
    expect(covers({ matchManagers: ['npm'], matchCategories: ['python'] }, npm)).toBeUndefined();
    expect(covers({ matchManagers: ['npm'], matchDatasources: ['npm'], matchUpdateTypes: ['patch'] }, npm)).toEqual(['patch']);
    expect(covers({ matchDatasources: ['github-tags'] }, actions)).toEqual(all);
    expect(covers({ matchDatasources: ['npm'] }, actions)).toBeUndefined();
  });

  it('tells a matcher it cannot read from one that does not match', () => {
    expect(ruleCoverage(renovate, { matchManagers: ['{npm,bun}'] }, npm)).toEqual({ kind: 'unknown', matcher: 'matchManagers' });
    expect(ruleCoverage(renovate, { matchCategories: ['[jp]s'] }, npm)).toEqual({ kind: 'unknown', matcher: 'matchCategories' });
    expect(ruleCoverage(renovate, { matchManagers: [7] }, npm)).toEqual({ kind: 'unknown', matcher: 'matchManagers' });
    expect(ruleCoverage(renovate, { matchManagers: ['bun', '{npm,bun}'] }, bun)).toMatchObject({ kind: 'covers' });
    expect(ruleCoverage(renovate, { matchManagers: ['bun'] }, npm)).toEqual({ kind: 'narrow' });
    expect(ruleScope(renovate, { matchManagers: ['{npm,bun}'] }, npm)).toBeUndefined();
  });
});

describe('renovateDelay', () => {
  const delay = (config: unknown, ecosystem: 'npm' | 'pypi' | RenovateTarget = 'npm') => {
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

  it('gives each manager the rules of its manager and categories, and the actions of workflows theirs', () => {
    const config = {
      minimumReleaseAge: '3 days',
      packageRules: [
        { matchManagers: ['npm'], minimumReleaseAge: '1 hour' },
        { matchCategories: ['ci'], matchUpdateTypes: ['major'], minimumReleaseAge: '1 day' },
        { matchManagers: ['{npm,bun}'], minimumReleaseAge: '2 hours' },
      ],
    };
    const result = (target: RenovateTarget | undefined) => (target === undefined ? undefined : delay(config, target));
    expect(result(managerTarget(renovate, 'npm', 'npm'))).toEqual({ major: '1 hour', minor: '1 hour', patch: '1 hour' });
    expect(result(managerTarget(renovate, 'bun', 'npm'))).toEqual({ major: '3 days', minor: '3 days', patch: '3 days' });
    expect(result(actionsTarget(renovate))).toEqual({ major: '1 day', minor: '3 days', patch: '3 days' });
    // config:best-practices delays the npm datasource only.
    expect(delay({ extends: ['config:best-practices'] }, actionsTarget(renovate) as RenovateTarget)).toEqual({});
  });

  it('lists the rules whose matchers it cannot read', () => {
    const config = readRenovateConfig(JSON.stringify({ packageRules: [{ matchManagers: ['{npm,bun}'], minimumReleaseAge: '1 hour' }, { matchManagers: ['{npm,bun}'] }] }, null, 2), 'renovate.json', []);
    const result = renovateDelay(renovate, config, managerTarget(renovate, 'npm', 'npm'));
    expect(result.known && result.unreadable).toEqual([{ index: 0, line: 3, matcher: 'matchManagers', patterns: ['{npm,bun}'], value: '1 hour' }]);
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
