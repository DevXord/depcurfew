// Readable doctor output: findings grouped by file, then notices.
import type { DoctorReport, Finding, Rule } from './types.ts';

export function countLevels(findings: readonly Finding[]): Record<'error' | 'warning' | 'note', number> {
  const counts = { error: 0, warning: 0, note: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  return counts;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

export function renderText(report: DoctorReport, rules: readonly Rule[]): string {
  const counts = countLevels(report.findings);
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push('No problems found.');
  } else {
    lines.push(`${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')}, ${plural(counts.note, 'note')}`);
    let file: string | undefined;
    for (const finding of report.findings) {
      if (finding.location.file !== file) {
        file = finding.location.file;
        lines.push('', file);
      }
      const where = finding.location.line === undefined ? '' : `${finding.location.line}: `;
      const help = finding.fix ?? rules.find((rule) => rule.id === finding.rule)?.help;
      lines.push(`  ${where}${finding.level} ${finding.message} (${finding.rule})`);
      if (help !== undefined) lines.push(`    fix: ${help}`);
    }
  }
  if (report.notices.length > 0) {
    lines.push('', 'Notes:', ...report.notices.map((notice) => `  ${notice.message}`));
  }
  return `${lines.join('\n')}\n`;
}
