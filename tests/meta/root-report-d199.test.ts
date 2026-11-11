// Decision D-199: the root job of CI runs the tests that need root with sudo and Vitest's JSON reporter, and
// tests/support/root-report.ts then fails the job unless every listed file ran tests and every test passed. Vitest
// itself passes when tests are skipped (a gate that did not see root) and ignores a file filter that matches nothing.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rootReportProblems, type VitestReport } from '../support/root-report.ts';

const ROOT = join('/', 'work', 'depcurfew');
const FILES = ['tests/apply/write-owner.test.ts', 'tests/user/write-owner.test.ts'];

function report(results: Record<string, string[]>): VitestReport {
  return {
    testResults: Object.entries(results).map(([file, statuses]) => ({
      name: join(ROOT, file),
      assertionResults: statuses.map((status, index) => ({ fullName: `case ${index + 1}`, status })),
    })),
  };
}

describe('the report of the root-only tests (decision D-199)', () => {
  it('passes when every listed file ran tests and all of them passed', () => {
    expect(rootReportProblems(report({ [FILES[0] ?? '']: ['passed', 'passed'], [FILES[1] ?? '']: ['passed'] }), FILES, ROOT)).toEqual([]);
  });

  it('names a test that was skipped, left as a todo, still pending or failed, with its file', () => {
    const problems = rootReportProblems(report({ [FILES[0] ?? '']: ['passed', 'skipped', 'todo'], [FILES[1] ?? '']: ['pending', 'failed'] }), FILES, ROOT);
    expect(problems).toEqual([
      expect.stringMatching(/^tests\/apply\/write-owner\.test\.ts: the test "case 2" is skipped, not passed: .*asRoot/u),
      expect.stringMatching(/^tests\/apply\/write-owner\.test\.ts: the test "case 3" is todo, not passed/u),
      expect.stringMatching(/^tests\/user\/write-owner\.test\.ts: the test "case 1" is pending, not passed/u),
      expect.stringMatching(/^tests\/user\/write-owner\.test\.ts: the test "case 2" is failed, not passed/u),
    ]);
  });

  it('names a listed file that ran no test: missing, renamed, or with no test in it', () => {
    const problems = rootReportProblems(report({ [FILES[0] ?? '']: ['passed'], 'tests/other.test.ts': [] }), [...FILES, 'tests/other.test.ts'], ROOT);
    expect(problems).toEqual([
      expect.stringMatching(/^tests\/user\/write-owner\.test\.ts ran no test as root: .*ROOT_TESTS in \.github\/workflows\/ci\.yml/u),
      expect.stringMatching(/^tests\/other\.test\.ts ran no test as root/u),
    ]);
  });

  it('fails when it is given no file at all', () => {
    expect(rootReportProblems(report({}), [], ROOT)).toEqual([expect.stringMatching(/^no test file was given: .*ROOT_TESTS/u)]);
  });
});
