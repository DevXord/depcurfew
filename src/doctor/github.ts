// doctor findings for people reading a GitHub Actions run: annotations on the files and a Markdown job summary.
// Both carry text from the repository (file and package names), so annotation values are escaped the way
// @actions/core escapes them and Markdown is escaped so a crafted name cannot add links, HTML or table cells.
// Control characters in messages and paths are shown as text (printable), as in the log: the log viewer reads ANSI
// sequences. That holds for the file of an annotation too, so a path with control characters loses its link to the file.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import { printable } from '../printable.ts';
import type { AnnotationLimitsKnowledge, AnnotationsKnowledge } from '../knowledge/types.ts';
import { checkedTool, countLevels, resultCounts, resultText } from './render.ts';
import type { DoctorReport, Finding, Level, Rule } from './types.ts';

const LEVELS: readonly Level[] = ['error', 'warning', 'note'];

function fixOf(finding: Finding, rules: readonly Rule[]): string | undefined {
  return finding.fix ?? rules.find((rule) => rule.id === finding.rule)?.help;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function escaped(text: string, replacements: readonly (readonly [string, string])[]): string {
  return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}

export interface Annotations {
  /** Workflow command lines, one per annotation. */
  lines: string[];
  /** Findings left out because GitHub would not show more annotations. */
  omitted: number;
}

/** Annotation commands for the findings, errors first, within the number GitHub shows in one step. */
export function annotationCommands(
  report: DoctorReport,
  rules: readonly Rule[],
  format: AnnotationsKnowledge | undefined = values(environment.githubActions.annotations)[0],
  limits: AnnotationLimitsKnowledge | undefined = values(environment.githubActions.annotationLimits)[0],
): Annotations {
  if (format === undefined || limits === undefined) return { lines: [], omitted: report.findings.length };
  const data = (text: string) => escaped(text, format.escape);
  const property = (text: string) => escaped(escaped(text, format.escape), format.escapeProperty);
  const lines: string[] = [];
  for (const level of LEVELS) {
    const findings = report.findings.filter((finding) => finding.level === level);
    for (const finding of findings.slice(0, Math.min(limits.perLevelPerStep, limits.perJob - lines.length))) {
      const properties = [
        [format.properties.file, printable(finding.location.file)],
        [format.properties.line, finding.location.line === undefined ? undefined : String(finding.location.line)],
        [format.properties.title, `depcurfew: ${finding.rule}`],
      ].flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${property(value)}`]));
      const fix = fixOf(finding, rules);
      const message = fix === undefined ? printable(finding.message) : `${printable(finding.message)}\nFix: ${printable(fix)}`;
      lines.push(`::${format.commands[level]} ${properties.join(',')}::${data(message)}`);
    }
  }
  return { lines, omitted: report.findings.length - lines.length };
}

/**
 * A notice annotation for a clean report, so that the run shows that doctor ran and what it checked: the tools, the
 * number of files read and every check with its result, one per line.
 */
export function cleanNotice(report: DoctorReport, format: AnnotationsKnowledge | undefined = values(environment.githubActions.annotations)[0]): string | undefined {
  if (format === undefined || report.findings.length > 0) return undefined;
  const data = (text: string) => escaped(text, format.escape);
  const property = (text: string) => escaped(escaped(text, format.escape), format.escapeProperty);
  const checked = report.checked;
  const lines =
    checked === undefined
      ? ['No problems found']
      : [
          `No problems found in ${plural(checked.files.length, 'file')}${checked.tools.length === 0 ? '' : ` for ${checked.tools.map(checkedTool).join(', ')}`}. ${resultCounts(checked.rules)}.`,
          ...checked.rules.map((result) => `${resultText(result)}: ${result.check}${result.result === 'skipped' ? ` (needs ${checked.policyFile})` : ''}`),
        ];
  return `::${format.commands.note} ${format.properties.title}=${property('depcurfew doctor: no problems found')}::${data(lines.map((line) => printable(line)).join('\n'))}`;
}

/** Markdown text with code spans kept: outside them special characters are escaped, inside only the table pipe. */
export function markdown(text: string): string {
  const flat = printable(text.replaceAll(/\s*[\r\n]+\s*/gu, ' '));
  return flat
    .split(/(`[^`]*`)/u)
    .map((part, index) =>
      index % 2 === 1
        ? part.replaceAll('|', '\\|')
        : part
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll(/([\\`*_[\]|~#!])/gu, '\\$1')
            .replaceAll(/(https?|www)(?=[:.])/gu, '$1&#8203;'),
    )
    .join('');
}

/** A path or rule id as a code span; a line break in a path is shown as text, so it cannot end the table row. */
function code(text: string): string {
  const shown = printable(text);
  return shown.includes('`') ? markdown(shown) : `\`${shown.replaceAll('|', '\\|')}\``;
}

/**
 * The job summary: the counts, a table of findings with how to fix each one and the notices. Rows that would make it
 * longer than `maxBytes` are left out and counted instead, so the summary upload does not fail.
 */
export function jobSummary(report: DoctorReport, rules: readonly Rule[], directory: string, maxBytes: number): string {
  const counts = countLevels(report.findings);
  const where = directory === '' ? '' : ` in ${code(directory)}`;
  const head = ['## depcurfew doctor', ''];
  if (report.findings.length === 0) {
    head.push(`**No problems found**${where}.`);
  } else {
    const count = (level: Level) => (counts[level] === 0 ? plural(0, level) : `**${plural(counts[level], level)}**`);
    head.push(`${count('error')}, ${count('warning')}, ${count('note')}${where}.`, '', '| Level | Where | Problem | How to fix |', '| --- | --- | --- | --- |');
  }
  const notes =
    report.notices.length === 0 ? [] : ['', '### Notes', '', ...report.notices.map((notice) => `- ${markdown(notice.message)}`)];
  const tail = [...notes, ...checkedSummary(report), ''];
  let size = Buffer.byteLength([...head, ...tail].join('\n')) + 200;
  const rows: string[] = [];
  for (const finding of report.findings) {
    const location = finding.location.line === undefined ? finding.location.file : `${finding.location.file}:${finding.location.line}`;
    const level = finding.level === 'error' ? '**error**' : finding.level;
    const row = `| ${level} | ${code(location)} | ${markdown(finding.message)} (${code(finding.rule)}) | ${markdown(fixOf(finding, rules) ?? '')} |`;
    size += Buffer.byteLength(row) + 1;
    if (size > maxBytes) break;
    rows.push(row);
  }
  const omitted = report.findings.length - rows.length;
  const more = omitted === 0 ? [] : ['', `${plural(omitted, 'more finding')} did not fit in the summary; the step log lists every finding.`];
  return [...head, ...rows, ...more, ...tail].join('\n');
}

/** What doctor checked, below the findings: the tools, the files read and a table of every check with its result. */
function checkedSummary(report: DoctorReport): string[] {
  const checked = report.checked;
  if (checked === undefined) return [];
  return [
    '',
    '### What was checked',
    '',
    `- Tools: ${checked.tools.length === 0 ? 'no package manager or bot found' : checked.tools.map((tool) => markdown(checkedTool(tool))).join(', ')}`,
    `- Files read: ${checked.files.length === 0 ? 'none' : checked.files.map(code).join(', ')}`,
    `- ${markdown(resultCounts(checked.rules))}`,
    '',
    '| Result | Check | Rule |',
    '| --- | --- | --- |',
    ...checked.rules.map((result) => {
      const shown = result.result === 'problems' ? `**${resultText(result)}**` : result.result === 'skipped' ? `skipped (needs ${code(checked.policyFile)})` : 'passed';
      return `| ${shown} | ${markdown(result.check)} | ${code(result.rule)} |`;
    }),
  ];
}

/** A problem after doctor ran, such as a SARIF file that cannot be written: a line below the findings of the job summary. */
export function problemSummary(message: string): string {
  return ['', `**Error:** depcurfew ${markdown(message)}`, ''].join('\n');
}

/** The job summary when doctor could not run. */
export function failureSummary(message: string): string {
  return ['## depcurfew doctor', '', `depcurfew could not check the repository: ${markdown(message)}`, ''].join('\n');
}
