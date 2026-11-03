// depcurfew check and the check_packages tool of depcurfew mcp on composer: packages (decision D-133): the text and the
// JSON of check, the root composer.json of the checked directory, notices that concern npm only, and what an agent
// gets. The Packagist answers are recorded (tests/fixtures/packagist/).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGIST_IS_UNREACHABLE, UNREAD_REGISTRY_IS_THE_USERS } from '../../src/check/hook.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { findTool } from '../../src/mcp/tools.ts';
import { osvFetch } from '../support/osv.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d133-cli-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '14d' }, installScripts: { default: 'deny' } });

async function exec(argv: string[], fetch = recordedFetch): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { fetch, now: () => NOW, stdin: async () => '', home: () => HOME, projectDir: () => undefined });
  return { code, stdout, stderr };
}

describe('depcurfew check with composer: packages', () => {
  it('writes Composer versions as composer require takes them, and gives no npm notices for them', async () => {
    const root = project({ 'depcurfew.json': POLICY, '.npmrc': 'registry=https://npm.corp.example/\ntag=next\n', 'package.json': '{}' });
    const ok = await exec(['check', '--dir', root, 'composer:monolog/monolog']);
    expect(ok).toEqual({ code: EXIT_OK, stdout: 'composer:monolog/monolog:3.12.1: ok (published 2026-09-29)\n\n1 package: 0 with errors, 0 with warnings\n', stderr: '' });
    const young = await exec(['check', '--dir', root, 'composer:guzzlehttp/guzzle']);
    expect(young.code).toBe(EXIT_FAILURE);
    expect(young.stdout).toBe(
      'composer:guzzlehttp/guzzle:8.3.1:\n  error: composer:guzzlehttp/guzzle:8.3.1 was published on Packagist 7 days ago; depcurfew.json requires 2 weeks (composer:guzzlehttp/guzzle:8.3.0 is old enough)\n    fix: Install composer:guzzlehttp/guzzle:8.3.0 instead, or wait until composer:guzzlehttp/guzzle:8.3.1 is 2 weeks old\n\n1 package: 1 with errors, 0 with warnings\n',
    );
    const json = await exec(['check', '--json', '--dir', root, 'composer:monolog/monolog:^3.11']);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      policy: 'depcurfew.json',
      packages: [
        {
          spec: 'composer:monolog/monolog:^3.11',
          kind: 'registry',
          name: 'composer:monolog/monolog',
          findings: [],
          latest: { version: '3.12.1', publishedAt: '2026-09-29T19:21:44+00:00' },
          version: '3.12.1',
          publishedAt: '2026-09-29T19:21:44+00:00',
        },
      ],
      notices: [],
      errors: [],
    });
  });

  it('does not vouch for a package the root composer.json may take from another repository', async () => {
    const root = project({ 'depcurfew.json': POLICY, 'composer.json': '{\n  "repositories": [\n    { "type": "composer", "url": "https://packages.corp.example" }\n  ]\n}\n' });
    const result = await exec(['check', '--json', '--dir', root, 'composer:monolog/monolog', 'lodash@4.17.21', 'pypi:requests']);
    const document = JSON.parse(result.stdout) as { packages: { spec: string; findings: { code: string; message: string; fix: string }[] }[] };
    expect(result.code).toBe(EXIT_FAILURE);
    expect(document.packages[0]?.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message:
          'the install may take it from the composer repository https://packages.corp.example that composer.json (line 3) declares, which Composer asks before Packagist; depcurfew checks only Packagist (https://repo.packagist.org), so it did not look the package up',
        fix: 'Before installing it, check the package in the repositories that composer.json declares: depcurfew checks only Packagist (https://repo.packagist.org), so it cannot vouch for a package from another repository',
      },
    ]);
    // composer.json concerns Composer packages only.
    expect(document.packages[1]?.findings.map((finding) => finding.code)).not.toContain('unverified');
    expect(document.packages[2]?.findings.map((finding) => finding.code)).not.toContain('unverified');
    // The composer.json of a parent directory in the repository counts when the checked directory has none, as Composer
    // looks for it.
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'src');
    mkdirSync(nested);
    expect((JSON.parse((await exec(['check', '--json', '--dir', nested, 'composer:monolog/monolog'])).stdout) as typeof document).packages[0]?.findings[0]?.code).toBe('unverified');
    // A composer.json that cannot be read is named in a note.
    const broken = project({ 'depcurfew.json': POLICY, 'composer.json': '{ not json' });
    const notes = await exec(['check', '--dir', broken, 'composer:monolog/monolog']);
    expect(notes.code).toBe(EXIT_OK);
    expect(notes.stderr).toContain('note: composer.json was not read: it cannot be parsed; the repositories it may declare were not looked at (config-not-read)');
  });

  it('looks the picked version up in OSV.dev with --osv, as a Packagist version', async () => {
    const root = project({ 'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '7d' } }) });
    const fetch = osvFetch();
    const result = await exec(['check', '--osv', '--json', '--dir', root, 'composer:intercom/intercom-php:5.0.2'], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    expect((JSON.parse(result.stdout) as { packages: { findings: unknown[] }[] }).packages[0]?.findings).toEqual([
      {
        level: 'error',
        code: 'known-malicious',
        message: 'composer:intercom/intercom-php:5.0.2 is a known malicious version: OSV.dev lists it as MAL-2026-3637 (https://osv.dev/vulnerability/MAL-2026-3637)',
        fix: 'Do not install it; pick another package or version. If it is installed anywhere already, remove it and read the record on OSV.dev for what it does',
        source: 'osv-api',
      },
    ]);
    expect(fetch.requests).toEqual([[{ package: { name: 'intercom/intercom-php', ecosystem: 'Packagist' }, version: '5.0.2' }]]);
  });

  it('gives an agent in check_packages what it can do about a Composer package', async () => {
    const root = project({ 'depcurfew.json': POLICY, 'app/composer.json': '{"repositories": [{"packagist.org": false}]}' });
    const tool = findTool('check_packages');
    if (tool === undefined) throw new Error('check_packages');
    const context = { projectDir: root, registry: undefined, index: undefined, home: HOME, fetch: recordedFetch, now: () => NOW };
    const checked = await tool.run({ packages: ['composer:guzzlehttp/guzzle', 'composer:monolog/monolog'] }, context, new AbortController().signal);
    const document = checked.structuredContent as { packages: { findings: { code: string; fix: string }[] }[] };
    expect(document.packages[0]?.findings).toEqual([expect.objectContaining({ code: 'too-young', fix: 'Install composer:guzzlehttp/guzzle:8.3.0 instead, or wait until composer:guzzlehttp/guzzle:8.3.1 is 2 weeks old' })]);
    expect(document.packages[1]?.findings).toEqual([]);
    const elsewhere = await tool.run({ packages: ['composer:monolog/monolog'], directory: 'app' }, context, new AbortController().signal);
    expect((elsewhere.structuredContent as typeof document).packages[0]?.findings).toEqual([expect.objectContaining({ code: 'unverified', fix: UNREAD_REGISTRY_IS_THE_USERS })]);
    const offline = await tool.run({ packages: ['composer:monolog/monolog'] }, { ...context, fetch: () => Promise.reject(new TypeError('fetch failed')) }, new AbortController().signal);
    expect((offline.structuredContent as typeof document).packages[0]?.findings).toEqual([expect.objectContaining({ code: 'unverified', fix: PACKAGIST_IS_UNREACHABLE })]);
  });
});
