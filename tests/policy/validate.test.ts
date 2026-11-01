import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import type { Duration } from '../../src/policy/duration.ts';
import type { Policy, ResolvedPolicy } from '../../src/policy/schema.ts';
import { formatIssue, parsePolicy, validatePolicy } from '../../src/policy/validate.ts';
import { buildTool, setPath, TODAY } from '../knowledge/builders.ts';

describe('parsePolicy', () => {
  it('reports invalid JSON with the line and column', () => {
    const result = parsePolicy('{\n  "version": 1,\n}\n');
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toEqual([
      { path: '(root)', message: expect.stringMatching(/^invalid JSON at line 3, column 1: \S/) },
    ]);
  });

  it('reports text after the JSON value with the line and column', () => {
    const result = parsePolicy('{ "version": 1 }\n{ "version": 1 }\n');
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      expect.stringMatching(/^\(root\): invalid JSON at line 2, column 1: .+ after the JSON value$/),
    ]);
  });

  it('computes the line and column when the engine reports only the position', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected token } in JSON at position 18');
    });
    try {
      const result = parsePolicy('{\n  "version": 1,\n}\n');
      expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual(['(root): invalid JSON at line 3, column 1: Unexpected token }']);
    } finally {
      parse.mockRestore();
    }
  });

  it('reports an empty file as invalid JSON', () => {
    const result = parsePolicy('');
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([expect.stringMatching(/^\(root\): invalid JSON: /)]);
  });

  it('ignores a UTF-8 byte order mark', () => {
    expect(parsePolicy('﻿{ "version": 1 }')).toEqual({ ok: true, policy: { version: 1, targets: 'auto', projects: [] } });
  });
});

describe('validatePolicy', () => {
  it('accepts the default policy written by init', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toMatchObject({ ok: true });
    expect(parsePolicy(renderPolicy(DEFAULT_POLICY))).toEqual(validatePolicy(DEFAULT_POLICY));
  });

  it('accepts the init fixture, which is what init writes', () => {
    const fixture = readFileSync(new URL('../fixtures/init/depcurfew.json', import.meta.url), 'utf8');
    expect(parsePolicy(fixture)).toMatchObject({ ok: true });
  });

  it('does not change its input', () => {
    const input = structuredClone(DEFAULT_POLICY);
    validatePolicy(input);
    expect(input).toEqual(DEFAULT_POLICY);
  });

  it('checks the cooldown against every listed target using the given knowledge base', () => {
    const strict = buildTool('npm') as unknown as Record<string, unknown>;
    setPath(strict, 'cooldown.unit', { status: 'verified', value: 'days', source: 'https://docs.npmjs.com/x', verifiedAt: TODAY });
    setPath(strict, 'extra.maximumDays', { status: 'verified', value: 2, source: 'https://docs.npmjs.com/x', verifiedAt: TODAY });
    const tools = [strict as unknown as ToolKnowledge];
    const policy = { version: 1, cooldown: { minimum: '3d' }, targets: ['npm'] };

    expect(validatePolicy(policy, tools)).toEqual({
      ok: false,
      issues: [{ path: 'cooldown.minimum', message: 'Sample npm accepts at most 2 days, but 3d needs 3 days' }],
    });
    expect(validatePolicy(policy, knowledgeBase)).toMatchObject({ ok: true });
  });

  it('leaves tool limits to apply when targets is auto', () => {
    expect(validatePolicy({ version: 1, cooldown: { minimum: '13w' } })).toMatchObject({ ok: true });
  });

  it('still reports cross-field problems when other parts of the file are invalid', () => {
    const result = validatePolicy({
      version: 2,
      cooldown: { minimum: '13w' },
      installScripts: { default: 'allow', allow: ['esbuild'] },
      targets: ['dependabot'],
    });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      'version: must be 1, got 2',
      'installScripts.allow: has no effect when default is "allow"; remove the list or set default to "deny"',
      'cooldown.minimum: Dependabot accepts at most 90 days, but 13w needs 91 days',
    ]);
  });

  it('does not suggest a field name that is not close', () => {
    const result = validatePolicy({ version: 1, cooldown: { minimum: '3d', exclusions: [] } });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual(['cooldown: unknown field "exclusions"']);
  });

  it('names unusual keys in quotes and nested list positions in brackets', () => {
    const result = validatePolicy({ version: 1, 'odd key': true, installScripts: { default: 'deny', allow: ['a', 'b c'] } });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      '(root): unknown field "odd key"',
      'installScripts.allow[1]: invalid package pattern "b c": must not contain spaces',
    ]);
  });
});

describe('doctor section (decision D-112)', () => {
  it('is optional, so a policy without it keeps failing on errors only', () => {
    const result = validatePolicy({ version: 1 });
    expect(result.ok && result.policy.doctor).toBeUndefined();
  });

  it('takes failOn "error" or "warning", "error" when the field is left out', () => {
    expect(validatePolicy({ version: 1, doctor: { failOn: 'warning' } })).toMatchObject({ ok: true, policy: { doctor: { failOn: 'warning' } } });
    expect(validatePolicy({ version: 1, doctor: { failOn: 'error' } })).toMatchObject({ ok: true, policy: { doctor: { failOn: 'error' } } });
    expect(validatePolicy({ version: 1, doctor: {} })).toMatchObject({ ok: true, policy: { doctor: { failOn: 'error' } } });
  });

  it('says which values failOn takes, and suggests the likely one', () => {
    const issues = (document: unknown) => {
      const result = validatePolicy(document);
      return result.ok ? [] : result.issues.map(formatIssue);
    };
    expect(issues({ version: 1, doctor: { failOn: 'warnings' } })).toEqual(['doctor.failOn: must be one of "error", "warning", got "warnings"; did you mean "warning"?']);
    expect(issues({ version: 1, doctor: { failOn: true } })).toEqual(['doctor.failOn: must be one of "error", "warning", got true']);
    expect(issues({ version: 1, doctor: { failon: 'warning' } })).toEqual(['doctor: unknown field "failon"; did you mean "failOn"?']);
    expect(issues({ version: 1, doctor: 'warning' })).toEqual(['doctor: must be an object, got "warning"']);
    expect(issues({ version: 1, doctr: { failOn: 'warning' } })).toEqual(['(root): unknown field "doctr"; did you mean "doctor"?']);
  });

  it('is part of the default policy of init, which fails on warnings', () => {
    expect(DEFAULT_POLICY.doctor).toEqual({ failOn: 'warning' });
    expectTypeOf<NonNullable<ResolvedPolicy['doctor']>['failOn']>().toEqualTypeOf<'error' | 'warning'>();
  });
});

describe('policy types', () => {
  it('describe the file and the resolved policy from one definition', () => {
    expectTypeOf<Policy['version']>().toEqualTypeOf<1>();
    expectTypeOf<NonNullable<Policy['cooldown']>['minimum']>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<Policy['cooldown']>['exclude']>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<Policy['targets']>().toEqualTypeOf<'auto' | readonly ToolKnowledge['id'][] | undefined>();

    expectTypeOf<NonNullable<ResolvedPolicy['cooldown']>['minimum']>().toEqualTypeOf<Duration>();
    expectTypeOf<NonNullable<ResolvedPolicy['cooldown']>['exclude']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<NonNullable<ResolvedPolicy['cooldown']>['securityUpdates']>().toEqualTypeOf<'bypass' | 'delay'>();
    expectTypeOf<NonNullable<ResolvedPolicy['installScripts']>['default']>().toEqualTypeOf<'allow' | 'deny'>();
    expectTypeOf<NonNullable<ResolvedPolicy['sources']>['git']>().toEqualTypeOf<'allow' | 'deny' | undefined>();
    expectTypeOf<ResolvedPolicy['targets']>().toEqualTypeOf<'auto' | readonly ToolKnowledge['id'][]>();
  });
});
