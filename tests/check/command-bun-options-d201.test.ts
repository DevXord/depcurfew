// Decision D-201: Bun's command line as Bun 1.4.4 reads it (src/install/PackageManager/CommandLineArguments.rs at
// bun-v1.4.4). bunx and bun x skip the options of npm, pnpm and Yarn together with their value (IGNORED_FOREIGN_FLAGS and
// IGNORED_NPX_FLAGS), unless that value starts with a dash; bun add, install, update and remove take a value after
// --linker, --cpu, --os, --libc and --minimum-release-age-excludes, which exempts packages from the release-age delay.
// Bun 1.3.0 to 1.4.3 skipped an option they did not know without a value, so the word after such an option is still
// checked as a package (Bun 1.2.18 to 1.2.22, which lack --cpu or --os, are not covered), and one the registry does not
// have is only a warning.
import { describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { InstallOverridesKnowledge, VerifiedFact } from '../../src/knowledge/types.ts';

const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);
const overrides = (line: string) => scanCommandLine(line).overrides?.map((override) => `${override.tool}:${override.weakens}:${override.written}`) ?? [];

describe('bunx and bun x read the options of npm, pnpm and Yarn that Bun skips with their value', () => {
  it.each([
    // Bun 1.4.4 runs evil-pkg; Bun 1.3.0 to 1.4.3 run lodash with evil-pkg as its argument: both are checked.
    ['bunx --before lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    ['bunx --tag lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    ['bun x --before lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    ['bunx --prefix lodash --dir lodash --cache lodash --store-dir lodash evil-pkg', ['bun:lodash', 'bun:lodash', 'bun:lodash', 'bun:lodash', 'bun:evil-pkg']],
    // Only bunx skips the options of npx and pnpm dlx (IGNORED_NPX_FLAGS).
    ['bunx --shell lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    ['bunx --npm lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    ['bunx --cpu x64 evil-pkg', ['bun:x64', 'bun:evil-pkg']],
    ['bunx --os linux --libc musl --omit dev evil-pkg', ['bun:linux', 'bun:musl', 'bun:dev', 'bun:evil-pkg']],
    // --node-arg takes the next word whatever it is in Bun 1.4.4.
    ['bunx --node-arg lodash evil-pkg', ['bun:lodash', 'bun:evil-pkg']],
    // A value in the same word is skipped with its option by every Bun.
    ['bunx --before=2026-01-01 evil-pkg', ['bun:evil-pkg']],
    ['bunx --tag=next --node-arg=--inspect evil-pkg', ['bun:evil-pkg']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('takes no word that starts with a dash for the value, as Bun does', () => {
    // Bun skips --before alone, so --registry=… points bunx at another registry and --trust lets scripts run.
    const registry = scanCommandLine('bunx --before --registry=https://npm.evil.example lodash');
    expect(registry.unreadable).toContain('--registry may point');
    expect(registry.aside?.map((request) => request.spec)).toEqual(['lodash']);
    expect(specs('bunx --tag --trust lodash')).toEqual(['bun:lodash']);
    expect(overrides('bunx --tag --trust lodash')).toEqual(['bun:scripts:--trust']);
    expect(specs('bunx --node-arg --inspect evil-pkg')).toEqual(['bun:evil-pkg']);
    expect(specs('bunx --omit --trust lodash')).toEqual(['bun:lodash']);
    expect(overrides('bunx --omit --trust lodash')).toEqual(['bun:scripts:--trust']);
  });

  it('checks the word after such an option as the package only while no --package named it', () => {
    // Bun 1.3.0 to 1.4.3 run the package typescript in both, with the binary next or tsc.
    expect(specs('bunx -p typescript --tag next tsc')).toEqual(['bun:typescript']);
    // Here they take next for the package and pass -p typescript tsc to it; Bun 1.4.4 runs tsc of typescript.
    expect(specs('bunx --tag next -p typescript tsc')).toEqual(['bun:next', 'bun:typescript']);
  });

  it('leaves the forms it read before as they were', () => {
    expect(specs('bunx cowsay hi')).toEqual(['bun:cowsay']);
    expect(specs('bun x --bun vite')).toEqual(['bun:vite']);
    expect(specs('bunx -p typescript tsc')).toEqual(['bun:typescript']);
    expect(specs('bunx --cwd packages/app vite')).toEqual(['bun:vite']);
    expect(specs('bunx --minimum-release-age 259200 cowsay')).toEqual(['bun:cowsay']);
    // Before x, bun takes the first word that is no option for the command (decision D-160).
    expect(specs('bun --before lodash x evil-pkg')).toEqual([]);
  });
});

describe('bun add, install, update and remove read the values of their own options', () => {
  it.each([
    ['bun add --cpu x64 left-pad', ['bun:left-pad']],
    ['bun add --os linux left-pad', ['bun:left-pad']],
    ['bun add --linker hoisted left-pad', ['bun:left-pad']],
    ['bun install --cpu arm64 --os darwin left-pad', ['bun:left-pad']],
    ['bun add --cpu=x64 left-pad', ['bun:left-pad']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
  });

  it('still checks the word after an option that only Bun 1.4.4 reads with a value', () => {
    // Bun 1.3.0 to 1.4.3 have no --libc and install musl as a package; they skip --before and --tag alone too.
    expect(specs('bun add --libc musl left-pad')).toEqual(['bun:musl', 'bun:left-pad']);
    expect(specs('bun add --libc=musl left-pad')).toEqual(['bun:left-pad']);
    expect(specs('bun add --before 2026-01-01 left-pad')).toEqual(['bun:2026-01-01', 'bun:left-pad']);
    expect(specs('bun add --tag --trust left-pad')).toEqual(['bun:left-pad']);
    expect(overrides('bun add --tag --trust left-pad')).toEqual(['bun:scripts:--trust']);
  });
});

describe('a word checked as a package that Bun 1.4.4 reads as the value of an option', () => {
  const marked = (line: string) => scanCommandLine(line).requests.map((request) => [request.spec, request.optionValue]);

  it('carries the option, the version that reads its value and the one-word form', () => {
    expect(marked('bun add --libc musl left-pad')).toEqual([
      ['musl', { option: '--libc', since: '1.4.4', written: '--libc=musl' }],
      ['left-pad', undefined],
    ]);
    expect(marked('bunx --before 2026-01-01 cowsay')).toEqual([
      ['2026-01-01', { option: '--before', since: '1.4.4', written: '--before=2026-01-01' }],
      ['cowsay', undefined],
    ]);
    expect(marked('bun install --minimum-release-age-excludes left-pad,typescript')).toEqual([
      ['left-pad', { option: '--minimum-release-age-excludes', since: '1.4.4', written: '--minimum-release-age-excludes=left-pad,typescript' }],
      ['typescript', { option: '--minimum-release-age-excludes', since: '1.4.4', written: '--minimum-release-age-excludes=left-pad,typescript' }],
    ]);
  });

  it('leaves the other requests unmarked', () => {
    expect(marked('bun add --cpu x64 left-pad')).toEqual([['left-pad', undefined]]);
    expect(marked('bunx --minimum-release-age-excludes y x')).toEqual([['y', undefined]]);
    expect(marked('bun add musl')).toEqual([['musl', undefined]]);
  });
});

describe('--minimum-release-age-excludes weakens the release-age delay (Bun 1.4.4)', () => {
  it('is an override in bun add, bun install and bun update', () => {
    expect(overrides('bun add x --minimum-release-age-excludes y')).toEqual(['bun:delay:--minimum-release-age-excludes y']);
    expect(overrides('bun add x --minimum-release-age-excludes=y')).toEqual(['bun:delay:--minimum-release-age-excludes=y']);
    expect(overrides('bun install --minimum-release-age-excludes left-pad,typescript')).toEqual(['bun:delay:--minimum-release-age-excludes left-pad,typescript']);
    expect(overrides('bun update --minimum-release-age-excludes y')).toEqual(['bun:delay:--minimum-release-age-excludes']);
    expect(overrides('bun a x --minimum-release-age-excludes y')).toEqual(['bun:delay:--minimum-release-age-excludes y']);
  });

  it('checks the packages it exempts, one by one, which Bun before 1.4.4 installs', () => {
    expect(specs('bun add x --minimum-release-age-excludes y')).toEqual(['bun:x', 'bun:y']);
    expect(specs('bun add x --minimum-release-age-excludes=y')).toEqual(['bun:x']);
    expect(specs('bun install --minimum-release-age-excludes left-pad,typescript@5.4.5')).toEqual(['bun:left-pad', 'bun:typescript@5.4.5']);
    expect(specs('bun install --minimum-release-age-excludes " left-pad , ,typescript"')).toEqual(['bun:left-pad', 'bun:typescript']);
  });

  it('is no override of bunx, which has no such option', () => {
    // Bun 1.4.4 stops with "bunx has no --minimum-release-age-excludes flag"; older ones run y.
    expect(specs('bunx --minimum-release-age-excludes y x')).toEqual(['bun:y']);
  });
});

describe('the knowledge base', () => {
  const bun = knowledgeBase.find((tool) => tool.id === 'bun');
  const fact = (key: string) => bun?.extra?.[key] as VerifiedFact<unknown> | undefined;

  it('takes the option tables from CommandLineArguments.rs at bun-v1.4.4, verified on 2026-11-11', () => {
    const values = fact('optionValues');
    expect(values?.status).toBe('verified');
    expect(values?.source).toBe('https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/install/PackageManager/CommandLineArguments.rs');
    expect(values?.verifiedAt).toBe('2026-11-11');
  });

  it('lists --minimum-release-age-excludes among the overrides, with the version that added it', () => {
    const overridesFact = fact('installOverrides') as VerifiedFact<InstallOverridesKnowledge> | undefined;
    expect(overridesFact?.value.options).toContainEqual({ name: '--minimum-release-age-excludes', weakens: 'delay', values: 'any' });
    expect(overridesFact?.note).toContain('1.4.4');
    expect(overridesFact?.verifiedAt).toBe('2026-11-11');
  });
});
