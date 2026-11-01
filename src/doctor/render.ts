// Readable doctor output: findings grouped by file, then notices. File names and messages carry text from the
// repository, so control characters in them are shown as visible text (printable) before colors are added.
import { PLAIN, type Paint } from '../color.ts';
import { printable } from '../printable.ts';
import type { Checked, CheckedTool, DoctorReport, Finding, Level, Rule, RuleResult } from './types.ts';

export function countLevels(findings: readonly Finding[]): Record<'error' | 'warning' | 'note', number> {
  const counts = { error: 0, warning: 0, note: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  return counts;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function levelColor(level: Level, colors: Paint): (text: string) => string {
  if (level === 'error') return (text) => colors.bold(colors.red(text));
  return level === 'warning' ? colors.yellow : colors.cyan;
}

/** A tool as the log of what was checked names it: npm 11.21.1 (package.json), and in a project npm 11.21.1 (frontend/package.json) in frontend. */
export function checkedTool(tool: CheckedTool): string {
  const where = `${tool.project === undefined ? '' : ` in ${tool.project}`}${tool.unread === true ? ` (not read by ${tool.name})` : ''}`;
  if (tool.version === undefined) return `${tool.name}${where}`;
  return `${tool.name} ${tool.version}${tool.versionFrom === undefined ? '' : ` (${tool.versionFrom})`}${where}`;
}

/**
 * Each rule with what it checks and what came of it, from the findings of the run. A rule with findings has problems
 * whatever `applies` says; one that does not apply is not applicable rather than skipped, since a policy would not
 * give it anything to check.
 */
export function ruleResults(
  rules: readonly Rule[],
  findings: readonly Finding[],
  skipped: (rule: Rule) => boolean,
  applies: (rule: Rule) => boolean = () => true,
): RuleResult[] {
  return rules.map((rule) => {
    const own = findings.filter((finding) => finding.rule === rule.id);
    const count = (level: Level) => own.filter((finding) => finding.level === level).length;
    const result: RuleResult['result'] = own.length > 0 ? 'problems' : !applies(rule) ? 'not-applicable' : skipped(rule) ? 'skipped' : 'passed';
    return { rule: rule.id, check: rule.checks ?? rule.summary, result, errors: count('error'), warnings: count('warning'), notes: count('note') };
  });
}

/** The result of one check as words or counts: passed, skipped, not applicable, or "1 error, 2 warnings". */
export function resultText(result: RuleResult): string {
  if (result.result === 'not-applicable') return 'not applicable';
  if (result.result !== 'problems') return result.result;
  return (
    [
      [result.errors, 'error'],
      [result.warnings, 'warning'],
      [result.notes, 'note'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, word]) => plural(count, word))
    .join(', ');
}

/** The checks that passed, failed or did not run, counted for one line. */
export function resultCounts(results: readonly RuleResult[]): string {
  const of = (kind: RuleResult['result']) => results.filter((result) => result.result === kind).length;
  const parts = [`${of('passed')} passed`];
  if (of('problems') > 0) parts.push(`${of('problems')} found problems`);
  if (of('not-applicable') > 0) parts.push(`${of('not-applicable')} not applicable`);
  if (of('skipped') > 0) parts.push(`${of('skipped')} skipped`);
  return `${results.length} ${results.length === 1 ? 'check' : 'checks'}: ${parts.join(', ')}`;
}

/**
 * What doctor checked, below the result: the tools found, the files read and every check with its result, so that a
 * clean report says what it covers and is not mistaken for one that did nothing.
 */
export function checkedLines(checked: Checked): string[] {
  const width = Math.max(...checked.rules.map((result) => resultText(result).length), 'passed'.length);
  return [
    'What was checked:',
    `  Tools: ${checked.tools.length === 0 ? 'no package manager or bot found' : checked.tools.map(checkedTool).join(', ')}`,
    `  Files read: ${checked.files.length === 0 ? 'none' : checked.files.join(', ')}`,
    `  ${resultCounts(checked.rules)}`,
    ...checked.rules.map(
      (result) => `    ${resultText(result).padEnd(width)}  ${result.check}${result.result === 'skipped' ? ` (needs ${checked.policyFile})` : ''} [${result.rule}]`,
    ),
  ];
}

/** The line --strict adds when warnings make doctor fail. */
export const STRICT_NOTE = '--strict: warnings count as failures, so depcurfew doctor exits with 1';

export function renderText(report: DoctorReport, rules: readonly Rule[], colors: Paint = PLAIN, options: { strict?: boolean } = {}): string {
  const counts = countLevels(report.findings);
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push(colors.green('No problems found.'));
  } else {
    const count = (level: Level) => (counts[level] === 0 ? plural(0, level) : levelColor(level, colors)(plural(counts[level], level)));
    lines.push(`${count('error')}, ${count('warning')}, ${count('note')}`);
    // With --strict a warning alone makes doctor fail; say so next to the counts.
    if (options.strict === true && counts.warning > 0) lines.push(STRICT_NOTE);
    let file: string | undefined;
    for (const finding of report.findings) {
      if (finding.location.file !== file) {
        file = finding.location.file;
        lines.push('', colors.bold(printable(file)));
      }
      const where = finding.location.line === undefined ? '' : `${finding.location.line}: `;
      const help = finding.fix ?? rules.find((rule) => rule.id === finding.rule)?.help;
      lines.push(`  ${where}${levelColor(finding.level, colors)(finding.level)} ${printable(finding.message)} ${colors.dim(`(${printable(finding.rule)})`)}`);
      if (help !== undefined) lines.push(`    ${colors.green('fix:')} ${printable(help)}`);
    }
  }
  if (report.notices.length > 0) {
    lines.push('', colors.bold('Notes:'), ...report.notices.map((notice) => `  ${printable(notice.message)}`));
  }
  if (report.checked !== undefined) lines.push('', ...checkedLines(report.checked).map((line, index) => (index === 0 ? colors.bold(printable(line)) : printable(line))));
  return `${lines.join('\n')}\n`;
}
