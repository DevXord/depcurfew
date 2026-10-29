// SARIF 2.1.0 output for GitHub code scanning. Every rule is listed in the driver, every finding has a location
// relative to the repository root, and notices become tool execution notifications.
import type { DoctorReport, Rule } from './types.ts';

export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const INFORMATION_URI = 'https://github.com/DevXord/depgate';

function ruleName(id: string): string {
  return id.replace(/(^|-)([a-z])/gu, (_match, _dash: string, letter: string) => letter.toUpperCase());
}

/** The text of a line in a repository file, to give regions the end column GitHub asks for. */
export type LineReader = (file: string, line: number) => string | undefined;

export function toSarif(report: DoctorReport, rules: readonly Rule[], version: string, readLine: LineReader = () => undefined): object {
  // GitHub code scanning marks startColumn, endLine and endColumn as required; the region spans the whole line.
  const location = (file: string, line: number | undefined) => {
    const startLine = line ?? 1;
    const text = readLine(file, startLine) ?? '';
    return {
      physicalLocation: {
        artifactLocation: { uri: file, uriBaseId: '%SRCROOT%' },
        region: { startLine, startColumn: 1, endLine: startLine, endColumn: Math.max(text.length, 1) + 1 },
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
            name: 'depgate',
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
            executionSuccessful: true,
            toolExecutionNotifications: report.notices.map((notice) => ({
              level: 'note',
              message: { text: notice.message },
              ...(notice.file === undefined ? {} : { locations: [location(notice.file, undefined)] }),
            })),
          },
        ],
        results: report.findings.map((finding) => ({
          ruleId: finding.rule,
          ...(index.has(finding.rule) ? { ruleIndex: index.get(finding.rule) } : {}),
          level: finding.level,
          message: { text: finding.fix === undefined ? finding.message : `${finding.message}. Fix: ${finding.fix}` },
          locations: [location(finding.location.file, finding.location.line)],
        })),
      },
    ],
  };
}
