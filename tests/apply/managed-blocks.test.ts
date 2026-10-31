// Managed blocks and the lines apply comments out (D-074): a setting apply commented out comes back once the
// policy no longer manages it, every copy of a duplicated block is removed, and uv and PDM keep separate blocks
// in one pyproject.toml.
import { describe, expect, it } from 'vitest';
import { BLOCK_END, BLOCK_START, blockStart, removeBlock, SUPERSEDED, TURNED_OFF } from '../../src/apply/block.ts';
import { writeIniBlock } from '../../src/apply/ini.ts';
import { writeRequirementsBlock } from '../../src/apply/pip-requirements.ts';
import { writeTomlBlock } from '../../src/apply/toml.ts';
import { parseToml } from '../../src/detect/toml.ts';

describe('removeBlock', () => {
  it('removes every copy of a duplicated block and reports where the first one was', () => {
    const lines = ['a=1', '', BLOCK_START, 'x=1', BLOCK_END, 'b=2', '', BLOCK_START, 'x=2', BLOCK_END, 'c=3'];
    expect(removeBlock(lines)).toEqual({ lines: ['a=1', 'b=2', 'c=3'], at: 1, separated: true });
  });

  it('replaces duplicated .npmrc blocks with one block', () => {
    const body = `save-exact=true\n\n${BLOCK_START}\nmin-release-age=1\n${BLOCK_END}\n\n${BLOCK_START}\nmin-release-age=2\n${BLOCK_END}\n`;
    const once = writeIniBlock(body, ['min-release-age=3'], ['min-release-age']);
    expect(once).toBe(`save-exact=true\n\n${BLOCK_START}\nmin-release-age=3\n${BLOCK_END}\n`);
    expect(writeIniBlock(once, ['min-release-age=3'], ['min-release-age'])).toBe(once);
  });
});

describe('a setting apply commented out comes back when the policy stops managing it', () => {
  it('.npmrc: superseded and turned-off lines', () => {
    const body = `save-exact=true\n${SUPERSEDED}min-release-age=10\n${TURNED_OFF}dangerously-allow-all-scripts=true\n\n${BLOCK_START}\nmin-release-age=3\n${BLOCK_END}\n`;
    const restored = writeIniBlock(body, [], []);
    expect(restored).toBe('save-exact=true\nmin-release-age=10\ndangerously-allow-all-scripts=true\n');
    expect(writeIniBlock(restored, [], [])).toBe(restored);
  });

  it('.npmrc: only the keys the policy no longer manages', () => {
    const body = `${SUPERSEDED}min-release-age=10\n${SUPERSEDED}allow-git=all\n\n${BLOCK_START}\nmin-release-age=3\nallow-git=none\n${BLOCK_END}\n`;
    expect(writeIniBlock(body, ['allow-git=none'], ['allow-git'])).toBe(`min-release-age=10\n${SUPERSEDED}allow-git=all\n\n${BLOCK_START}\nallow-git=none\n${BLOCK_END}\n`);
  });

  it('.npmrc: a line that comes back is commented out again when the policy manages it again', () => {
    const managed = writeIniBlock('min-release-age=10\n', ['min-release-age=3'], ['min-release-age']);
    const released = writeIniBlock(managed, [], []);
    expect(released).toBe('min-release-age=10\n');
    expect(writeIniBlock(released, ['min-release-age=3'], ['min-release-age'])).toBe(managed);
  });

  it('requirements.txt: --only-binary and --no-binary lines', () => {
    const body = `${BLOCK_START}\n--only-binary=:all:\n${BLOCK_END}\nrequests==2.32.0\nlxml\n${SUPERSEDED}--no-binary=lxml\n${SUPERSEDED}--only-binary :none:\n`;
    const restored = writeRequirementsBlock(body, [], []);
    expect(restored).toBe('requests==2.32.0\nlxml\n--no-binary=lxml\n--only-binary :none:\n');
    expect(writeRequirementsBlock(restored, [], [])).toBe(restored);
  });

  it('TOML: a value over several lines comes back whole', () => {
    const body = `[install]\n${SUPERSEDED}minimumReleaseAgeExcludes = [\n#   "foo",\n# ]\nregistry = "x"\n\n${BLOCK_START}\nminimumReleaseAge = 259200\n${BLOCK_END}\n`;
    const restored = writeTomlBlock(body, 'install', [], []);
    expect(restored).toBe('[install]\nminimumReleaseAgeExcludes = [\n  "foo",\n]\nregistry = "x"\n');
    expect(parseToml(restored).root).toEqual({ install: { minimumReleaseAgeExcludes: ['foo'], registry: 'x' } });
  });

  it('TOML: a managed subtable and dotted keys at the top level come back', () => {
    const body = `${SUPERSEDED}install.minimumReleaseAge = 60\n\n[install]\nregistry = "x"\n\n${BLOCK_START}\nminimumReleaseAge = 1\n${BLOCK_END}\n\n${TURNED_OFF}[install.scopes]\n${TURNED_OFF}acme = "x"\n`;
    expect(writeTomlBlock(body, 'install', [], [])).toBe('install.minimumReleaseAge = 60\n\n[install]\nregistry = "x"\n\n[install.scopes]\nacme = "x"\n');
  });

  it('TOML: lines commented out in another table stay as they are', () => {
    const body = `[tool.uv]\n${SUPERSEDED}exclude-newer = "2024-01-01"\n\n[tool.pdm.resolution]\n${SUPERSEDED}exclude-newer = "2024-01-01"\n`;
    expect(writeTomlBlock(body, 'tool.uv', [], [], 'tool.uv')).toBe(`[tool.uv]\nexclude-newer = "2024-01-01"\n\n[tool.pdm.resolution]\n${SUPERSEDED}exclude-newer = "2024-01-01"\n`);
  });
});

describe('uv and PDM in one pyproject.toml', () => {
  const pyproject = '[project]\nname = "demo"\n\n[tool.uv]\ndev-dependencies = []\n\n[tool.pdm.resolution]\nprefer-binary = "idna"\n';
  const uv = (body: string, entries: string[]) => writeTomlBlock(body, 'tool.uv', entries, ['exclude-newer'], 'tool.uv');
  const pdm = (body: string, entries: string[]) => writeTomlBlock(body, 'tool.pdm.resolution', entries, ['exclude-newer'], 'tool.pdm.resolution');

  it('keeps one block for each table', () => {
    const once = pdm(uv(pyproject, ['exclude-newer = "3 days"']), ['exclude-newer = "3d"']);
    expect(once).toBe(
      `[project]\nname = "demo"\n\n[tool.uv]\ndev-dependencies = []\n\n${blockStart('tool.uv')}\nexclude-newer = "3 days"\n${BLOCK_END}\n\n[tool.pdm.resolution]\nprefer-binary = "idna"\n\n${blockStart('tool.pdm.resolution')}\nexclude-newer = "3d"\n${BLOCK_END}\n`,
    );
    expect(pdm(uv(once, ['exclude-newer = "3 days"']), ['exclude-newer = "3d"'])).toBe(once);
    expect(uv(once, [])).toBe(once.replace(`\n${blockStart('tool.uv')}\nexclude-newer = "3 days"\n${BLOCK_END}\n`, ''));
  });

  it('replaces the blocks an earlier version wrote without the table in the marker', () => {
    const legacy = `[project]\nname = "demo"\n\n[tool.uv]\ndev-dependencies = []\n\n${BLOCK_START}\nexclude-newer = "1 day"\n${BLOCK_END}\n\n[tool.pdm.resolution]\nprefer-binary = "idna"\n\n${BLOCK_START}\nexclude-newer = "1d"\n${BLOCK_END}\n`;
    const once = pdm(uv(legacy, ['exclude-newer = "3 days"']), ['exclude-newer = "3d"']);
    expect(once).toBe(pdm(uv(pyproject, ['exclude-newer = "3 days"']), ['exclude-newer = "3d"']));
  });

  it('leaves an unmarked block of the other table alone', () => {
    const legacy = `[tool.uv]\ndev-dependencies = []\n\n[tool.pdm.resolution]\nprefer-binary = "idna"\n\n${BLOCK_START}\nexclude-newer = "1d"\n${BLOCK_END}\n`;
    expect(uv(legacy, [])).toBe(legacy);
    expect(uv(legacy, ['exclude-newer = "3 days"'])).toBe(
      `[tool.uv]\ndev-dependencies = []\n\n${blockStart('tool.uv')}\nexclude-newer = "3 days"\n${BLOCK_END}\n\n[tool.pdm.resolution]\nprefer-binary = "idna"\n\n${BLOCK_START}\nexclude-newer = "1d"\n${BLOCK_END}\n`,
    );
  });
});
