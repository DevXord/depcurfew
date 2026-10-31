// pip reads a requirements file with optparse, which takes a long option shortened to any prefix that names exactly
// one option of the requirements parser (req_file.py build_parser): "--no-bin :all:" is --no-binary :all:, which
// after --only-binary=:all: allows building again. apply comments it out like the full option, and doctor reads it
// as the option it stands for (extra.requirementsParser).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { writeRequirementsBlock } from '../../src/apply/pip-requirements.ts';
import { BLOCK_END, BLOCK_START, SUPERSEDED } from '../../src/apply/block.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { requirementsFormatOf } from '../../src/doctor/python-lockfiles.ts';
import { expandRequirementsOption } from '../../src/doctor/python.ts';
import { pip } from '../../src/knowledge/pip.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const parser = requirementsFormatOf(pip)['parser'] as { longOptions: string[] };

function project(requirements: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-pip-abbreviations-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'requirements.txt'), requirements);
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, installScripts: { default: 'deny' } }));
  return directory;
}

describe('abbreviated options in requirements files', () => {
  it.each([
    ['--no-bin', '--no-binary'],
    ['--only-b', '--only-binary'],
    ['--extra', '--extra-index-url'],
    ['--pypi', '--pypi-url'],
    ['--no-binary', '--no-binary'],
    ['--no', '--no'],
    ['--pre', '--pre'],
    ['--uploaded-prior-to', '--uploaded-prior-to'],
  ])('reads %s as %s', (written, option) => {
    expect(expandRequirementsOption(written, parser.longOptions)).toBe(option);
  });

  it('comments out an abbreviated managed option and gives it back when the policy stops managing it', () => {
    const before = 'requests==2.32.0\n--no-bin :all:\n';
    const block = [BLOCK_START, '--only-binary=:all:', BLOCK_END];
    const after = writeRequirementsBlock(before, ['--only-binary=:all:'], ['--only-binary', '--no-binary'], parser.longOptions);
    expect(after).toBe([...block, 'requests==2.32.0', `${SUPERSEDED}--no-bin :all:`, ''].join('\n'));
    expect(writeRequirementsBlock(after, ['--only-binary=:all:'], ['--only-binary', '--no-binary'], parser.longOptions)).toBe(after);
    expect(writeRequirementsBlock(after, [], [], parser.longOptions)).toBe(before);
  });

  it('makes apply comment out --no-bin and doctor report it as drift, not as an option pip rejects', () => {
    const directory = project('requests==2.32.0\n');
    applyProject(directory, { write: true });
    writeFileSync(join(directory, 'requirements.txt'), `${'requests==2.32.0\n'}\n${BLOCK_START}\n--only-binary=:all:\n${BLOCK_END}\n--no-bin :all:\n`);
    const findings = runDoctor(directory).findings;
    expect(findings.filter((finding) => finding.rule === 'python-config-ignored')).toEqual([]);
    expect(findings.find((finding) => finding.rule === 'config-drift')?.message).toContain('`--no-bin :all:` is set outside the block that depcurfew manages');
    applyProject(directory, { write: true });
    expect(runDoctor(directory).findings.filter((finding) => finding.rule === 'config-drift' && finding.level === 'error')).toEqual([]);
  });

  it('still reports an ambiguous prefix and options pip rejects, but not --hash on a line of its own', () => {
    const findings = runDoctor(project('--no :all:\n--uploaded-prior-to=2026-01-01\n--hash=sha256:abc\nrequests==2.32.0\n')).findings.filter((finding) => finding.rule === 'python-config-ignored');
    expect(findings.map((finding) => finding.message)).toEqual([
      'pip does not accept --no in requirements files, so installing from requirements.txt fails',
      'pip does not accept --uploaded-prior-to in requirements files, so installing from requirements.txt fails',
    ]);
  });
});
