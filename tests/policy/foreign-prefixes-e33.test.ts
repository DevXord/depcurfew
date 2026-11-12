// Errors for package patterns with a prefix no version of depcurfew takes (E33). npm:, node: and npmjs: keep the npm
// hint (npm packages have no prefix); pip:, python: and py: point to pypi:; Ruby gems (gem:, rubygems:, ruby:,
// bundler:), JSR packages (jsr:), Rust crates (cargo:, crates:) and NuGet packages (nuget:) have no names in the policy,
// as for Ruby gems since Bundler support, so the entry has to go; any other prefix gets the list of prefixes and
// "remove the entry or fix the spelling". No message tells to write a package of another ecosystem as an npm name.
import { describe, expect, it } from 'vitest';
import { formatIssue, parsePolicy } from '../../src/policy/validate.ts';

function messageFor(entry: string): string {
  const result = parsePolicy(JSON.stringify({ version: 1, cooldown: { minimum: '3d', exclude: [entry] } }));
  if (result.ok) throw new Error(`${entry} was accepted`);
  const [issue] = result.issues;
  if (issue === undefined) throw new Error(`${entry} gave no issue`);
  return formatIssue(issue).replace(/^cooldown\.exclude\[0\]: invalid package pattern "[^"]*": /u, '');
}

const PREFIXES = 'the ecosystem prefixes are pypi: and composer:, and npm packages have none';

describe('package patterns with a foreign prefix (E33)', () => {
  it.each([
    ['npm:left-pad', `${PREFIXES}; write npm packages without a prefix, e.g. "left-pad"`],
    ['NODE:fs', `${PREFIXES}; write npm packages without a prefix, e.g. "fs"`],
    ['npmjs:@scope/x', `${PREFIXES}; write npm packages without a prefix, e.g. "@scope/x"`],
    ['npm:Not A Name', 'must not contain spaces'],
  ])('keeps the npm hint for %s', (entry, message) => {
    expect(messageFor(entry)).toBe(message);
  });

  it.each([
    ['pip:requests', `${PREFIXES}; write Python packages as "pypi:requests"`],
    ['python:Django', `${PREFIXES}; write Python packages as "pypi:Django"`],
    ['Py:numpy', `${PREFIXES}; write Python packages as "pypi:numpy"`],
    ['pypy:requests', `${PREFIXES}; write Python packages as "pypi:requests"`],
    ['packagist:monolog/monolog', `${PREFIXES}; write Composer packages as "composer:monolog/monolog"`],
    ['compsoer:a/b', `${PREFIXES}; write Composer packages as "composer:a/b"`],
    ['PHP:monolog/monolog', `${PREFIXES}; write Composer packages as "composer:monolog/monolog"`],
  ])('points %s to the prefix of its registry', (entry, message) => {
    expect(messageFor(entry)).toBe(message);
  });

  it.each([
    ['gem:rails', 'Ruby gems'],
    ['rubygems:rails', 'Ruby gems'],
    ['Ruby:rack', 'Ruby gems'],
    ['bundler:nokogiri', 'Ruby gems'],
    ['jsr:@std/path', 'JSR packages'],
    ['cargo:serde', 'Rust crates'],
    ['CRATES:tokio', 'Rust crates'],
    ['nuget:Newtonsoft.Json', 'NuGet packages'],
  ])('says that %s has no name in depcurfew.json, and to remove the entry', (entry, what) => {
    expect(messageFor(entry)).toBe(`${what} have no names in depcurfew.json, since no setting depcurfew writes takes one; remove this entry (${PREFIXES})`);
  });

  it.each(['foo:bar', 'github:owner/repo', 'git:x', 'bun:esbuild'])('gives %s the list of prefixes, without changing it into another name', (entry) => {
    expect(messageFor(entry)).toBe(`${PREFIXES}; remove the entry or fix the spelling of its prefix`);
  });

  it('never tells to write a package of another ecosystem as an npm name', () => {
    for (const entry of ['pip:requests', 'gem:rails', 'jsr:@std/path', 'cargo:serde', 'nuget:x', 'foo:bar', 'github:owner/repo', 'crates:tokio', 'ruby:rack']) {
      expect(messageFor(entry), entry).not.toMatch(/write npm packages|composer:owner/u);
      expect(messageFor(entry), entry).not.toMatch(/remove the prefix/iu);
    }
  });
});
