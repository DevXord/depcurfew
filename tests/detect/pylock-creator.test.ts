// A pylock.toml names the tool that wrote it (created-by, PEP 751); a supported Python tool other than pip claims it,
// so a Pipenv, uv, PDM or Poetry project is not taken for a pip project because of its exported lockfile.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';

let root: string;

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'depcurfew-pylock-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const lockfiles = () =>
  Object.fromEntries(detectProject(root).packageManagers.map((manager) => [manager.id, manager.evidence.filter((item) => item.kind === 'lockfile').map((item) => item.file)]));

describe('pylock.toml and created-by', () => {
  it('belongs to Pipenv when Pipenv wrote it', () => {
    write('Pipfile', '[packages]\nidna = "*"\n');
    write('Pipfile.lock', '{ "_meta": {}, "default": {} }\n');
    write('pylock.toml', 'lock-version = "1.0"\ncreated-by = "pipenv"\n\n[[packages]]\nname = "idna"\n');
    expect(lockfiles()).toEqual({ pipenv: ['Pipfile.lock', 'pylock.toml'] });
  });

  it.each([
    ['created-by = "uv"', 'uv'],
    ["created-by = 'pdm'", 'pdm'],
    ['created-by = "PDM"', 'pdm'],
    ['created-by = "poetry-plugin-export"', 'poetry'],
    ['created-by = "pip"', 'pip'],
    ['created-by = "some-other-locker"', 'pip'],
    ['', 'pip'],
  ])('%s gives the lockfile to %s', (line, owner) => {
    write('pyproject.toml', '[project]\nname = "app"\nversion = "1.0"\n');
    write('pylock.dev.toml', `lock-version = "1.0"\n${line}\n\n[[packages]]\nname = "idna"\n`);
    expect(lockfiles()).toEqual({ [owner]: ['pylock.dev.toml'] });
  });

  it('reads created-by only among the top-level keys', () => {
    write('pylock.toml', 'lock-version = "1.0"\ncreated-by = "pip"\n\n[tool.other]\ncreated-by = "uv"\n');
    expect(lockfiles()).toEqual({ pip: ['pylock.toml'] });
  });
});
