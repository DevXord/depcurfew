// SARIF 2.1.0 output for GitHub code scanning. Every rule is listed in the driver, every finding has a location
// relative to the repository root, and notices become tool execution notifications. When doctor could not run at
// all (a directory that does not exist), the run is marked as not successful and the error is a notification too.
import { Repository } from '../detect/repository.ts';
import type { DoctorReport, Rule } from './types.ts';

export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
// The npm page: it names only the product, so nothing in a user's code scanning results points to the author's account.
const INFORMATION_URI = 'https://www.npmjs.com/package/depcurfew';

function ruleName(id: string): string {
  return id.replace(/(^|-)([a-z])/gu, (_match, _dash: string, letter: string) => letter.toUpperCase());
}

/**
 * A repository-relative path as the relative URI reference SARIF asks for (RFC 3986): each segment percent-encoded
 * as UTF-8, so a space, `%`, `#`, `?`, a colon or a non-ASCII letter in a file name keeps its meaning; `/` stays.
 */
export function pathUri(file: string): string {
  return file
    .split('/')
    // A lone surrogate (no file system gives one, but a lockfile might) becomes U+FFFD instead of a URIError.
    .map((segment) => encodeURIComponent(segment.replaceAll(/[\uD800-\uDFFF]/gu, '\uFFFD')))
    .join('/');
}

/** The text of a line in a repository file, to give regions the end column GitHub asks for. */
export type LineReader = (file: string, line: number) => string | undefined;

/**
 * Reads lines of the repository's files; a file it cannot read (e.g. for lack of permission) gives no line. Each file
 * is read and split once: a lockfile with thousands of findings is not read again for each of them.
 */
export function lineReader(root: string): LineReader {
  const repository = new Repository(root);
  const files = new Map<string, string[] | undefined>();
  return (file, line) => {
    if (!files.has(file)) {
      try {
        files.set(file, repository.readText(file)?.split(/\r?\n/u));
      } catch {
        files.set(file, undefined);
      }
    }
    return files.get(file)?.[line - 1];
  };
}

/** Why doctor could not run, with a stable code. */
export interface SarifError {
  code: string;
  message: string;
  fix?: string;
}

export function toSarif(report: DoctorReport, rules: readonly Rule[], version: string, readLine: LineReader = () => undefined, errors: readonly SarifError[] = []): object {
  // GitHub code scanning marks startColumn, endLine and endColumn as required; the region spans the whole line.
  // A column that is known (a syntax error) starts the region; it still ends at the end of the line (decision D-116).
  const location = (file: string, line: number | undefined, column?: number) => {
    const startLine = line ?? 1;
    const text = readLine(file, startLine) ?? '';
    const startColumn = line === undefined ? 1 : (column ?? 1);
    return {
      physicalLocation: {
        artifactLocation: { uri: pathUri(file), uriBaseId: '%SRCROOT%' },
        region: { startLine, startColumn, endLine: startLine, endColumn: Math.max(text.length + 1, startColumn + 1, 2) },
      },
    };
  };
  const index = new Map(rules.map((rule, position) => [rule.id, position]));
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'depcurfew',
            version,
            informationUri: INFORMATION_URI,
            rules: rules.map((rule) => ({
              id: rule.id,
              name: ruleName(rule.id),
              shortDescription: { text: rule.summary },
              fullDescription: { text: rule.description },
              help: { text: rule.help },
              defaultConfiguration: { level: rule.level },
              properties: { tags: ['security', 'supply-chain'] },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: errors.length === 0,
            toolExecutionNotifications: [
              ...errors.map((error) => ({
                level: 'error',
                message: { text: error.fix === undefined ? error.message : `${error.message}. Fix: ${error.fix}` },
                descriptor: { id: error.code },
              })),
              ...report.notices.map((notice) => ({
                level: 'note',
                message: { text: notice.fix === undefined ? notice.message : `${notice.message}. Fix: ${notice.fix}` },
                ...(notice.file === undefined ? {} : { locations: [location(notice.file, notice.location?.line)] }),
                descriptor: { id: notice.code },
              })),
            ],
          },
        ],
        results: report.findings.map((finding) => ({
          ruleId: finding.rule,
          ...(index.has(finding.rule) ? { ruleIndex: index.get(finding.rule) } : {}),
          level: finding.level,
          message: { text: finding.fix === undefined ? finding.message : `${finding.message}. Fix: ${finding.fix}` },
          locations: [location(finding.location.file, finding.location.line, finding.location.column)],
        })),
      },
    ],
  };
}
