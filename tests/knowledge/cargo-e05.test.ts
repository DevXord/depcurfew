// The knowledge of Cargo (E05): every fact cites the cargo of Rust 1.100.0 (CARGO_RELEASE, a full commit) or the
// release manifest of Rust 1.100.0, never a branch or a beta; the facts pass the validator; Cargo's time span is read as
// Cargo reads it, with a product above u64 as a result of its own (a possible weakening). Cargo joins knowledgeBase,
// and with it targets and detection, in the next step (E06): until then nothing depcurfew does changes.
import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { cargoTimeSpan } from '../../src/doctor/durations.ts';
import { CARGO_RELEASE, cargo, RUST_1_100_MANIFEST, RUSTUP_RELEASE } from '../../src/knowledge/cargo.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { Ecosystem, Fact, ToolId } from '../../src/knowledge/types.ts';
import { validateKnowledge } from '../../src/knowledge/validate.ts';
import { cpuNow } from '../support/cpu-time.ts';
import { USER_GENERATORS } from '../../src/user/generators.ts';

/** Every fact of a tool entry, with its path. */
function facts(value: unknown, path = ''): [string, Fact<unknown>][] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record['status'] === 'string' && ('value' in record || 'variants' in record)) return [[path, value as Fact<unknown>]];
  return Object.entries(record).flatMap(([key, item]) => facts(item, path === '' ? key : `${path}.${key}`));
}

function sources(fact: Fact<unknown>): string[] {
  const record = fact as unknown as { source?: string; variants?: { source: string }[] };
  return record.variants === undefined ? [record.source ?? ''] : record.variants.map((variant) => variant.source);
}

describe('the knowledge of Cargo (E05)', () => {
  it('cites the cargo of Rust 1.100.0 by its full commit, or the release manifest of Rust 1.100.0', () => {
    expect(CARGO_RELEASE).toMatch(/^https:\/\/github\.com\/rust-lang\/cargo\/blob\/[0-9a-f]{40}$/u);
    expect(CARGO_RELEASE).toContain('3acc79c0c841844675bc53a605922dbfc441e750');
    expect(RUST_1_100_MANIFEST).toBe('https://static.rust-lang.org/dist/channel-rust-1.100.0.toml');
    const all = facts(cargo);
    expect(all.length).toBeGreaterThan(20);
    for (const [path, fact] of all) {
      for (const source of sources(fact)) {
        // The facts of rust-toolchain (E06) cite rustup 1.29.3 by its commit and the manifest of the channel 1.99.
        const pinned = source.startsWith(`${CARGO_RELEASE}/`) || source.startsWith(`${RUSTUP_RELEASE}/`) || source === RUST_1_100_MANIFEST || source === 'https://static.rust-lang.org/dist/channel-rust-1.99.toml';
        expect(pinned, `${path}: ${source}`).toBe(true);
        expect(source, path).not.toMatch(/\/(?:master|main|beta|nightly)\/|beta\.\d/u);
      }
    }
  });

  it('passes the validator of the knowledge base', () => {
    expect(validateKnowledge([cargo], '2026-11-13')).toEqual([]);
  });

  it('knows the keys, the variables and the switch of the delay, from Rust 1.100.0 on', () => {
    expect(values(cargo.cooldown.setting)).toEqual(['registry.global-min-publish-age']);
    expect(values(cargo.cooldown.configFiles)).toEqual([['.cargo/config.toml']]);
    expect(values(cargo.cooldown.unit)).toEqual(['duration-string']);
    expect(values(cargo.cooldown.availableSince)).toEqual(['1.100.0']);
    expect(values(cargo.cooldown.exclude.setting)).toEqual([null]);
    const extra = cargo.extra ?? {};
    expect(values(extra['registryMinPublishAge'] as Fact<unknown>)).toEqual([{ key: 'registries.<name>.min-publish-age', winsOverGlobal: true, cratesIo: 'crates-io' }]);
    expect(values(extra['resolverSwitch'] as Fact<unknown>)).toEqual([{ key: 'resolver.incompatible-publish-age', values: ['allow', 'deny'], default: 'deny', turnsOff: 'allow' }]);
    expect(values(extra['environment'] as Fact<unknown>)).toEqual([{ global: 'CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE', resolver: 'CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE' }]);
    expect(values(extra['registryVariable'] as Fact<unknown>)).toEqual([{ prefix: 'CARGO_REGISTRIES_', suffix: '_MIN_PUBLISH_AGE', name: 'as-written', needsTable: true }]);
    expect((extra['registryVariable'] as Fact<unknown>).status).toBe('uncertain');
    expect((extra['timeSpan'] as Fact<unknown>).status).toBe('uncertain');
    expect(values(extra['latestVersion'] as Fact<unknown>)).toEqual(['1.100.0']);
  });

  it('adds cargo to the tool ids and crates to the ecosystems, and to knowledgeBase with detection (E06)', () => {
    const id: ToolId = 'cargo';
    const ecosystem: Ecosystem = 'crates';
    expect([cargo.id, cargo.ecosystem]).toEqual([id, ecosystem]);
    expect(knowledgeBase.map((tool) => tool.id)).toContain('cargo');
  });

  it('gives every tool with a user file a user generator, so a user file is never known without one', () => {
    for (const tool of [...knowledgeBase, cargo]) {
      // Pipenv has a user section without a file of its own (files: null), only variables.
      const versions = tool.user === undefined ? [] : (values(tool.user.files).flat() as { value: unknown }[]);
      if (versions.some((version) => version.value !== null)) expect(USER_GENERATORS[tool.id], tool.id).toBeDefined();
    }
    expect(cargo.user).toBeUndefined();
  });
});

describe("Cargo's time span (E05)", () => {
  it.each([
    ['0', { kind: 'off' }],
    ['0 days', { kind: 'off' }],
    ['0seconds', { kind: 'off' }],
    ['7 days', { kind: 'delay', seconds: 604_800 }],
    ['1day', { kind: 'delay', seconds: 86_400 }],
    ['1 second', { kind: 'delay', seconds: 1 }],
    ['5 minutes', { kind: 'delay', seconds: 300 }],
    ['2 hours', { kind: 'delay', seconds: 7200 }],
    ['2 weeks', { kind: 'delay', seconds: 1_209_600 }],
    ['6 months', { kind: 'delay', seconds: 2_629_746 * 6 }],
    ['007 days', { kind: 'delay', seconds: 604_800 }],
    ['18446744073709551615 seconds', { kind: 'delay', seconds: 18_446_744_073_709_551_615 }],
    ['7014648591046 months', { kind: 'delay', seconds: 7_014_648_591_046 * 2_629_746 }],
    ['7014648591047 months', { kind: 'overflow' }],
    ['30500568904944 weeks', { kind: 'overflow' }],
    ['18446744073709551616 seconds', { kind: 'invalid' }],
    ['', { kind: 'invalid' }],
    ['1', { kind: 'invalid' }],
    ['days', { kind: 'invalid' }],
    ['+1 day', { kind: 'invalid' }],
    ['-1 days', { kind: 'invalid' }],
    ['1.5 days', { kind: 'invalid' }],
    ['1 dayz', { kind: 'invalid' }],
    ['1 day ', { kind: 'invalid' }],
    [' 1 day', { kind: 'invalid' }],
    ['1  day', { kind: 'invalid' }],
    ['7 DAYS', { kind: 'invalid' }],
    ['٧ days', { kind: 'invalid' }],
    ['never', { kind: 'invalid' }],
  ])('reads %j as Cargo does', (text, expected) => {
    expect(cargoTimeSpan(text)).toEqual(expected);
  });

  it('reads a long value in linear time', () => {
    const start = cpuNow();
    expect(cargoTimeSpan(`${'9'.repeat(1_000_000)} days`)).toEqual({ kind: 'invalid' });
    expect(cargoTimeSpan(`1 ${'d'.repeat(1_000_000)}`)).toEqual({ kind: 'invalid' });
    expect(cpuNow() - start).toBeLessThan(1000);
  });
});
