// explain matches apply for a Bundler too old to keep the Gemfile cooldown once Gemfile.lock exists (decision D-173):
// with BUNDLED WITH 4.0.13 and a Gemfile.lock, apply writes nothing for Bundler, so explain shows the delay as
// "cannot apply" with apply's version-too-old text.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-explain-bundler-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function repository(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-explain-bundler-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch: async () => new Response('{}', { status: 404 }),
    now: () => new Date('2026-11-03T12:00:00Z'),
    stdin: async () => '',
    home: () => HOME,
  });
  return { code, stdout };
}

const POLICY = {
  version: 1,
  cooldown: { minimum: '3d', exclude: [], securityUpdates: 'bypass' },
  installScripts: { default: 'deny', allow: [], deny: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
  targets: 'auto',
};

describe('explain for Bundler 4.0.13 with a Gemfile.lock (tests/fixtures/repos/bundler-old-version)', () => {
  it('says that apply cannot write the cooldown, as apply and doctor do', async () => {
    const root = repository({
      Gemfile: 'source "https://rubygems.org"\n\ngem "sinatra"\n',
      'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    sinatra (4.1.1)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  sinatra\n\nBUNDLED WITH\n   4.0.13\n',
      'depcurfew.json': POLICY,
    });
    const apply = JSON.parse((await exec('apply', '--dry-run', '--json', root)).stdout) as { changes: unknown[]; warnings: { code: string; message: string }[] };
    expect(apply.changes).toEqual([]);
    expect(apply.warnings.map((warning) => warning.message)).toContain('Bundler 4.0.13 does not support cooldown once Gemfile.lock exists (added in 4.0.14); not written');
    const explain = JSON.parse((await exec('explain', '--json', root)).stdout) as { policy: { cooldown: { tools: { tool: string; ok: boolean }[] } } };
    expect(explain.policy.cooldown.tools.find((entry) => entry.tool === 'bundler')?.ok).toBe(false);
    expect((await exec('explain', root)).stdout).toContain('does not support cooldown once Gemfile.lock exists');
  });
});
