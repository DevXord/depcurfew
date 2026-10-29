// doctor findings for people reading a GitHub Actions run: annotations on the files and a Markdown job summary.
// Both carry text from the repository (file and package names), so annotation values are escaped the way
// @actions/core escapes them and Markdown is escaped so a crafted name cannot add links, HTML or table cells.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type { AnnotationLimitsKnowledge, AnnotationsKnowledge } from '../knowledge/types.ts';
import { countLevels } from './render.ts';
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
        [format.properties.file, finding.location.file],
        [format.properties.line, finding.location.line === undefined ? undefined : String(finding.location.line)],
        [format.properties.title, `depcurfew: ${finding.rule}`],
      ].flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${property(value)}`]));
      const fix = fixOf(finding, rules);
      const message = fix === undefined ? finding.message : `${finding.message}\nFix: ${fix}`;
      lines.push(`::${format.commands[level]} ${properties.join(',')}::${data(message)}`);
    }
  }
  return { lines, omitted: report.findings.length - lines.length };
}

/** Markdown text with code spans kept: outside them special characters are escaped, inside only the table pipe. */
export function markdown(text: string): string {
  const flat = text.replaceAll(/\s*[\r\n]+\s*/gu, ' ');
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

function code(text: string): string {
  return text.includes('`') ? markdown(text) : `\`${text.replaceAll('|', '\\|')}\``;
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
    head.push(`No problems found${where}.`);
  } else {
    const count = (level: Level) => (counts[level] === 0 ? plural(0, level) : `**${plural(counts[level], level)}**`);
    head.push(`${count('error')}, ${count('warning')}, ${count('note')}${where}.`, '', '| Level | Where | Problem | How to fix |', '| --- | --- | --- | --- |');
  }
  const notes =
    report.notices.length === 0 ? [] : ['', '### Notes', '', ...report.notices.map((notice) => `- ${markdown(notice.message)}`)];
  const tail = [...notes, ''];
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

/** The job summary when doctor could not run. */
export function failureSummary(message: string): string {
  return ['## depcurfew doctor', '', `depcurfew could not check the repository: ${markdown(message)}`, ''].join('\n');
}
