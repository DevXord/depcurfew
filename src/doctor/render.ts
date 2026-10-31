// Readable doctor output: findings grouped by file, then notices. File names and messages carry text from the
// repository, so control characters in them are shown as visible text (printable) before colors are added.
import { PLAIN, type Paint } from '../color.ts';
import { printable } from '../printable.ts';
import type { Checked, CheckedTool, DoctorReport, Finding, Level, Rule } from './types.ts';

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

/** A tool as the log of what was checked names it: npm 11.21.1 (package.json). */
export function checkedTool(tool: CheckedTool): string {
  if (tool.version === undefined) return tool.name;
  return `${tool.name} ${tool.version}${tool.versionFrom === undefined ? '' : ` (${tool.versionFrom})`}`;
}

/** The lines below the result that say what doctor checked: tools, files read and rules, so a clean report is not mistaken for one that did nothing. */
export function checkedLines(checked: Checked): string[] {
  const skipped = checked.skippedRules.length === 0 ? '' : `; ${checked.skippedRules.length} more need ${checked.policyFile} and did not run`;
  return [
    `Checked: ${checked.tools.length === 0 ? 'no package manager or bot found' : checked.tools.map(checkedTool).join(', ')}`,
    `Files read: ${checked.files.length === 0 ? 'none' : checked.files.join(', ')}`,
    `Rules: ${checked.rules.length} ran${skipped}`,
  ];
}

export function renderText(report: DoctorReport, rules: readonly Rule[], colors: Paint = PLAIN): string {
  const counts = countLevels(report.findings);
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push(colors.green('No problems found.'));
  } else {
    const count = (level: Level) => (counts[level] === 0 ? plural(0, level) : levelColor(level, colors)(plural(counts[level], level)));
    lines.push(`${count('error')}, ${count('warning')}, ${count('note')}`);
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
  if (report.checked !== undefined) lines.push('', ...checkedLines(report.checked).map((line) => colors.dim(printable(line))));
  return `${lines.join('\n')}\n`;
}
