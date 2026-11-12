// Decision D-203 (amends D-065): pip 26.3 (2026-11-02) dropped "Installing a wheel does not run code from it" from its
// security policy (SECURITY.md at 26.2.2, line 38) and says that pip cannot guarantee that installing a wheel will not
// execute third-party code (SECURITY.md at 26.3, lines 26-27). So no fact and no hand-written README text says that
// installing a wheel runs no package code: a wheel installs without a build step. The pip facts follow one rule of
// provenance: a fact cites pip 26.3 only when it was read again at that release, never with a date before 26.3 existed,
// and every other fact keeps its pin to 26.2.2 and its date until the whole re-pin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { handWritten } from '../../src/docs/readme.ts';
import { collectFacts, evidenceOf } from '../../src/knowledge/facts.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';
import { pdm } from '../../src/knowledge/pdm.ts';
import { pip } from '../../src/knowledge/pip.ts';
import { poetry } from '../../src/knowledge/poetry.ts';
import { uv } from '../../src/knowledge/uv.ts';

const PIP_26_3 = 'https://github.com/pypa/pip/blob/26.3/';
const PIP_26_2_2 = 'https://github.com/pypa/pip/blob/26.2.2/';
const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
/** The claim pip's security policy no longer makes. */
const NO_CODE = /runs? no package code|without running package code|does not run (?:package )?code|runs? no code from/iu;

const everyFact = () => [...knowledgeBase.flatMap((tool) => collectFacts(tool).map((entry) => ({ tool: tool.id, ...entry }))), ...collectFacts(environment).map((entry) => ({ tool: 'environment', ...entry }))];
const noteOf = (fact: { note?: string }) => fact.note ?? '';

describe('what installing a wheel runs (decision D-203)', () => {
  it('no fact says that installing a wheel runs no package code', () => {
    const claims = everyFact().flatMap(({ tool, path, fact }) => [fact, ...evidenceOf(fact)].filter((entry) => NO_CODE.test(noteOf(entry))).map(() => `${tool}.${path}`));
    expect(claims).toEqual([]);
  });

  it('nor the hand-written text of README.md', () => {
    expect(handWritten(README)).not.toMatch(NO_CODE);
    expect(handWritten(README)).toContain('A wheel installs without a build step, so no build code runs');
  });

  it('uv, Poetry and PDM say a wheel runs no build step, and pip what its security policy says', () => {
    for (const tool of [uv, poetry, pdm]) expect(tool.installScripts?.defaultPolicy.note, tool.id).toMatch(/Installing a wheel runs no build step/u);
    const fact = pip.installScripts?.defaultPolicy;
    expect(fact).toMatchObject({ status: 'verified', source: `${PIP_26_3}docs/html/topics/secure-installs.md` });
    expect(fact?.note).toContain('pip cannot guarantee that installing a wheel will not execute third-party code');
    expect(fact?.note).toContain('SECURITY.md at 26.3, lines 26-27');
  });
});

describe('the pip facts of 26.3 (decision D-203)', () => {
  const pipFacts = () => collectFacts(pip).flatMap(({ path, fact }) => evidenceOf(fact).map((evidence) => ({ path, source: evidence.source, verifiedAt: evidence.verifiedAt })));

  it('no fact cites pip 26.3 with a date before 26.3 was released', () => {
    const early = everyFact().flatMap(({ tool, path, fact }) => evidenceOf(fact).filter((evidence) => evidence.source.startsWith(PIP_26_3) && evidence.verifiedAt < '2026-11-02').map(() => `${tool}.${path}`));
    expect(early).toEqual([]);
  });

  it('only the facts read again at 26.3 cite it; the others keep 26.2.2', () => {
    expect(pipFacts().filter((fact) => fact.source.startsWith(PIP_26_3)).map((fact) => fact.path)).toEqual([
      'installScripts.defaultPolicy',
      'user.invalidValueFails',
      'extra.machineSettings',
      'extra.pathExtras',
      'extra.commandLine',
      'extra.latestVersion',
      'extra.installOverrides',
    ]);
    // None of the facts that stay at 26.2.2 was dated again in this change.
    expect(pipFacts().filter((fact) => fact.source.startsWith(PIP_26_2_2) && fact.verifiedAt > '2026-11-03')).toEqual([]);
  });

  it('knows 26.3 as the latest version', () => {
    expect(values(pip.extra?.['latestVersion'] ?? { status: 'verified', value: '', source: '', verifiedAt: '' })).toEqual(['26.3']);
  });

  it('records the extras pip takes off a path, as strip_extras does', () => {
    const fact = pip.extra?.['pathExtras'];
    expect(fact).toMatchObject({ status: 'verified', value: { open: '[', close: ']' }, source: `${PIP_26_3}src/pip/_internal/utils/urls.py` });
    expect(fact?.status === 'verified' ? fact.note : '').toContain('lines 69-78');
  });
});
