// The last step of the job root of .github/workflows/ci.yml (decision D-199). That job runs the test files that import
// asRoot with sudo and Vitest's JSON reporter; Vitest passes when a test is skipped (a gate that did not see root) and
// ignores a file it is given that matches nothing, so this script fails the job unless every listed file ran tests and
// every test passed. Usage, from the root of the repository: node tests/support/root-report.ts <report.json> <file>...
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The parts of a report of Vitest's JSON reporter (Vitest 5.0.5, JsonReporter) that tell which tests ran. */
export interface VitestReport {
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
}

/** One line for each thing that shows a root-only test did not run as root and pass; empty when all did. */
export function rootReportProblems(report: VitestReport, files: readonly string[], root: string): string[] {
  if (files.length === 0) return ['no test file was given: list the root-only test files in ROOT_TESTS in .github/workflows/ci.yml'];
  const shown = (name: string) => relative(root, name).split(sep).join('/');
  const ran = new Map(report.testResults.map((result) => [shown(result.name), result.assertionResults.length]));
  const problems: string[] = [];
  for (const result of report.testResults) {
    for (const test of result.assertionResults) {
      if (test.status === 'passed') continue;
      problems.push(
        `${shown(result.name)}: the test "${test.fullName}" is ${test.status}, not passed: a test of this file that does not run as root shows that its gate did not see root, so run the file as root to see why, and gate it on asRoot from tests/support/platform.ts alone`,
      );
    }
  }
  for (const file of files) {
    if ((ran.get(file) ?? 0) === 0) problems.push(`${file} ran no test as root: the file is missing or has no test, so correct ROOT_TESTS in .github/workflows/ci.yml`);
  }
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file = '', ...files] = process.argv.slice(2);
  let problems: string[];
  try {
    problems = rootReportProblems(JSON.parse(readFileSync(file, 'utf8')) as VitestReport, files, process.cwd());
  } catch (error) {
    problems = [`the report ${file} of the root-only tests cannot be read (${error instanceof Error ? error.message : String(error)}): the step that runs them with sudo has to write it with --outputFile.json`];
  }
  for (const problem of problems) console.log(`::error::depcurfew: ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log(`Every test of ${files.length} root-only test files ran as root and passed.`);
}
