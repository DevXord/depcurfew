// Decision D-195: uv takes the value of a package in exclude-newer-package over exclude-newer ("Package-specific values
// will take precedence over both global and index-specific values"). apply commented out every entry with a date or a
// duration, so a package the project held back longer (certifi = "2026-10-01…", setuptools = "30 days") waited only
// cooldown.minimum, without a word (found by the review of 1.6.0, already in 1.5.2). A longer one now stays in the
// managed block; a shorter one is a partial exception, which apply comments out with exclusion-dropped.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d+Z$/u, 'Z');

function repository(file: string, text: string, policy: object = { cooldown: { minimum: '3d' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d195-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  if (file === 'uv.toml') writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "app"\nversion = "1.0.0"\n');
  writeFileSync(join(root, file), text);
  writeFileSync(join(root, 'uv.lock'), 'version = 1\n');
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, targets: ['uv'], ...policy }));
  return root;
}

const dropped = (report: ReturnType<typeof applyProject>) => report.warningDetails.filter((warning) => warning.code === 'exclusion-dropped').map((warning) => [warning.location, warning.message]);

describe('uv delays of single packages (decision D-195)', () => {
  it('keeps a longer one, warns about a shorter one, and the second apply changes nothing', () => {
    const earlier = daysAgo(30);
    const later = daysAgo(1);
    const root = repository(
      'pyproject.toml',
      `[project]\nname = "app"\nversion = "1.0.0"\n\n[tool.uv]\nexclude-newer = "1 day"\n\n[tool.uv.exclude-newer-package]\ncertifi = "${earlier}"\nidna = "${later}"\nsetuptools = "30 days"\nrequests = "1 day"\nlater = 2999-01-01\n`,
    );
    const report = applyProject(root);
    expect(readFileSync(join(root, 'pyproject.toml'), 'utf8')).toContain(`exclude-newer = "3 days"\nexclude-newer-package = { "certifi" = "${earlier}", "setuptools" = "30 days" }\n`);
    expect(dropped(report)).toEqual([
      [{ file: 'pyproject.toml', line: 10 }, expect.stringMatching(new RegExp(`^uv: exclude-newer-package in pyproject\\.toml \\(line 10\\) gives idna "${later}", which holds back only what was uploaded in the last (?:1 day|23 hours), shorter than cooldown\\.minimum "3d" in depcurfew\\.json, and uv takes the value of a package over exclude-newer; depcurfew apply comments it out, so uv delays idna like every other package$`, 'u'))],
      [{ file: 'pyproject.toml', line: 12 }, 'uv: exclude-newer-package in pyproject.toml (line 12) gives requests "1 day", a delay of 1 day, shorter than cooldown.minimum "3d" in depcurfew.json, and uv takes the value of a package over exclude-newer; depcurfew apply comments it out, so uv delays requests like every other package'],
      [{ file: 'pyproject.toml', line: 13 }, 'uv: exclude-newer-package in pyproject.toml (line 13) gives later 2999-01-01, a date to come, which holds back nothing, shorter than cooldown.minimum "3d" in depcurfew.json, and uv takes the value of a package over exclude-newer; depcurfew apply comments it out, so uv delays later like every other package'],
    ]);
    const second = applyProject(root);
    expect(second.changes).toEqual([]);
    expect(dropped(second)).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it('a package of cooldown.exclude is exempt instead, and uv.toml is read the same way', () => {
    const earlier = daysAgo(30);
    const root = repository('uv.toml', `exclude-newer-package = { certifi = "${earlier}", Six = "14 days", idna = "${earlier}" }\n`, { cooldown: { minimum: '3d', exclude: ['pypi:idna'] } });
    const report = applyProject(root);
    expect(readFileSync(join(root, 'uv.toml'), 'utf8')).toContain(`exclude-newer-package = { "idna" = false, "certifi" = "${earlier}", "Six" = "14 days" }\n`);
    expect(dropped(report)).toEqual([]);
    expect(applyProject(root).changes).toEqual([]);
  });
});
