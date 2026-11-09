// Composer versions and constraints (decision D-133): the normal forms of composer/semver 3.6.0, the internal forms
// of constraints that doc/articles/versions.md lists, PHP's version_compare and the stability flags of a requirement.
import { describe, expect, it } from 'vitest';
import { cpuNow } from '../support/cpu-time.ts';
import { compareVersions, matches, MAX_CONSTRAINT_LENGTH, namesBranch, normalizeVersion, parseConstraint, parseStability, stabilityFlag } from '../../src/check/composer-version.ts';

/** The constraint written back as composer/semver prints it: comparisons, a space for AND, || for OR, * for any. */
function shown(text: string): string | undefined {
  const parsed = parseConstraint(text);
  if (parsed === undefined) return undefined;
  const write = (constraint: NonNullable<typeof parsed>): string =>
    constraint.kind === 'all' ? '*' : constraint.kind === 'compare' ? `${constraint.operator}${constraint.version}` : constraint.parts.map(write).join(constraint.kind === 'and' ? ' ' : ' || ');
  return write(parsed);
}

describe('Composer versions', () => {
  it('normalizes versions as composer/semver does', () => {
    expect(normalizeVersion('1.2')).toBe('1.2.0.0');
    expect(normalizeVersion('v7.3.4')).toBe('7.3.4.0');
    expect(normalizeVersion('7.0.0-rc.1')).toBe('7.0.0.0-RC1');
    expect(normalizeVersion('v8.1.0-BETA3')).toBe('8.1.0.0-beta3');
    expect(normalizeVersion('2.0.0-b2')).toBe('2.0.0.0-beta2');
    expect(normalizeVersion('1.0.0-alpha.1+build.5')).toBe('1.0.0.0-alpha1');
    expect(normalizeVersion('1.0.0-patch1')).toBe('1.0.0.0-patch1');
    expect(normalizeVersion('1.0.0-stable')).toBe('1.0.0.0');
    expect(normalizeVersion('dev-main')).toBe('dev-main');
    expect(normalizeVersion('master')).toBe('dev-master');
    expect(normalizeVersion('2.x-dev')).toBe('2.9999999.9999999.9999999-dev');
    expect(normalizeVersion('1.2.x-dev')).toBe('1.2.9999999.9999999-dev');
    expect(normalizeVersion('20231231')).toBe('20231231');
    expect(normalizeVersion('2023-12-31')).toBe('2023.12.31');
    expect(normalizeVersion('1.0@beta')).toBe('1.0.0.0');
    expect(normalizeVersion('dev-main as 1.0.x-dev')).toBe('dev-main');
    expect(normalizeVersion('not a version')).toBeUndefined();
    expect(normalizeVersion('1.0.0.0.0')).toBeUndefined();
  });

  it('tells the stability of a version', () => {
    expect(parseStability('3.12.1.0')).toBe('stable');
    expect(parseStability('8.1.0.0-RC1')).toBe('RC');
    expect(parseStability('8.1.0.0-beta3')).toBe('beta');
    expect(parseStability('1.0.0.0-alpha1')).toBe('alpha');
    expect(parseStability('1.0.0.0-patch1')).toBe('stable');
    expect(parseStability('dev-main')).toBe('dev');
    expect(parseStability('2.9999999.9999999.9999999-dev')).toBe('dev');
  });

  it('orders versions as PHP version_compare does', () => {
    const sorted = ['1.0.0.0', '1.0.0.0-dev', '1.0.0.0-alpha1', '1.0.0.0-beta2', '1.0.0.0-beta10', '1.0.0.0-RC1', '1.0.0.0-patch1', '0.9.0.0', '10.0.0.0', '1.10.0.0'].sort(compareVersions);
    expect(sorted).toEqual(['0.9.0.0', '1.0.0.0-dev', '1.0.0.0-alpha1', '1.0.0.0-beta2', '1.0.0.0-beta10', '1.0.0.0-RC1', '1.0.0.0', '1.0.0.0-patch1', '1.10.0.0', '10.0.0.0']);
    expect(compareVersions('1.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0.0', '1.0.0.0')).toBe(0);
    expect(compareVersions('dev-main', '2.9999999.9999999.9999999-dev')).toBe(-1);
  });
});

describe('Composer constraints', () => {
  it('reads every form of doc/articles/versions.md as composer/semver does internally', () => {
    // The table "Stability Constraints" of versions.md.
    expect(shown('1.2.3')).toBe('==1.2.3.0');
    expect(shown('>1.2')).toBe('>1.2.0.0');
    expect(shown('>=1.2')).toBe('>=1.2.0.0-dev');
    expect(shown('>=1.2-stable')).toBe('>=1.2.0.0');
    expect(shown('<1.3')).toBe('<1.3.0.0-dev');
    expect(shown('<=1.3')).toBe('<=1.3.0.0');
    expect(shown('1 - 2')).toBe('>=1.0.0.0-dev <3.0.0.0-dev');
    expect(shown('~1.3')).toBe('>=1.3.0.0-dev <2.0.0.0-dev');
    expect(shown('1.4.*')).toBe('>=1.4.0.0-dev <1.5.0.0-dev');
    // The other examples of the page.
    expect(shown('1.0 - 2.0')).toBe('>=1.0.0.0-dev <2.1.0.0-dev');
    expect(shown('1.0.0 - 2.1.0')).toBe('>=1.0.0.0-dev <=2.1.0.0');
    expect(shown('~1.2.3')).toBe('>=1.2.3.0-dev <1.3.0.0-dev');
    expect(shown('~1')).toBe('>=1.0.0.0-dev <2.0.0.0-dev');
    expect(shown('^1.2.3')).toBe('>=1.2.3.0-dev <2.0.0.0-dev');
    expect(shown('^0.3')).toBe('>=0.3.0.0-dev <0.4.0.0-dev');
    expect(shown('^0.0.3')).toBe('>=0.0.3.0-dev <0.0.4.0-dev');
    expect(shown('>=1.0 <1.1 || >=1.2')).toBe('>=1.0.0.0-dev <1.1.0.0-dev || >=1.2.0.0-dev');
    expect(shown('>=1.0,<2.0')).toBe('>=1.0.0.0-dev <2.0.0.0-dev');
    expect(shown('^1.0 | ^2.0')).toBe('>=1.0.0.0-dev <2.0.0.0-dev || >=2.0.0.0-dev <3.0.0.0-dev');
    expect(shown('*')).toBe('*');
    expect(shown('1.*')).toBe('>=1.0.0.0-dev <2.0.0.0-dev');
    expect(shown('0.*')).toBe('<1.0.0.0-dev');
    expect(shown('!=1.5')).toBe('!=1.5.0.0');
    expect(shown('<>1.5')).toBe('!=1.5.0.0');
  });

  it('keeps stability flags, branches, aliases and commits as composer/semver does', () => {
    expect(shown('^1.0@beta')).toBe('>=1.0.0.0-dev <2.0.0.0-dev');
    expect(shown('>1.0@beta')).toBe('>1.0.0.0-beta');
    expect(shown('@dev')).toBe('*');
    expect(shown('dev-main')).toBe('==dev-main');
    expect(shown('dev-main#abc123')).toBe('==dev-main');
    expect(shown('1.x-dev')).toBe('==1.9999999.9999999.9999999-dev');
    expect(shown('dev-main as 1.0.x-dev')).toBe('==dev-main');
    expect(shown('feature-dev')).toBe('==dev-feature');
    expect(shown('~>1.2')).toBeUndefined();
    expect(shown('not a constraint')).toBeUndefined();
    expect(shown('')).toBeUndefined();
  });

  it('matches versions, branches only by their own name', () => {
    const constraint = parseConstraint('^7.15');
    if (constraint === undefined) throw new Error('constraint');
    expect(matches(constraint, '7.16.1.0')).toBe(true);
    expect(matches(constraint, '8.0.0.0')).toBe(false);
    expect(matches(constraint, '8.0.0.0-beta1')).toBe(false);
    expect(matches(constraint, '7.15.0.0-beta1')).toBe(true);
    expect(matches(constraint, '7.x-dev')).toBe(false);
    const branch = parseConstraint('dev-main');
    if (branch === undefined) throw new Error('branch');
    expect(matches(branch, 'dev-main')).toBe(true);
    expect(matches(branch, 'dev-other')).toBe(false);
    expect(namesBranch(branch)).toBe(true);
    expect(namesBranch(constraint)).toBe(false);
    expect(matches({ kind: 'all' }, 'dev-main')).toBe(true);
  });

  it('takes the stability flag of a requirement as RootPackageLoader does', () => {
    expect(stabilityFlag('^1.0')).toBeUndefined();
    expect(stabilityFlag('^1.0@beta')).toBe('beta');
    expect(stabilityFlag('^1.0@beta || ^2.0@alpha')).toBe('alpha');
    expect(stabilityFlag('@dev')).toBe('dev');
    expect(stabilityFlag('2.0.0-RC1')).toBe('RC');
    expect(stabilityFlag('>=3.0.0-RC1 <3.1')).toBe('RC');
    expect(stabilityFlag('dev-main')).toBe('dev');
    expect(stabilityFlag('1.0.0-beta1', 'dev')).toBeUndefined();
  });

  it('reads long constraints in linear time and refuses ones longer than it reads', () => {
    const started = cpuNow();
    expect(parseConstraint(`1.0.0-beta${'1'.repeat(900)}x`)).toBeUndefined();
    expect(normalizeVersion(`1.0.0-beta${'1.'.repeat(400)}x`)).toBeUndefined();
    expect(cpuNow() - started).toBeLessThan(1000);
    expect(parseConstraint(`^${'1'.repeat(MAX_CONSTRAINT_LENGTH)}`)).toBeUndefined();
  });
});
