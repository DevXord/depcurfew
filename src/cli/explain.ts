import { detectProject } from '../detect/index.ts';
import type { Detection, VersionDeclaration } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId } from '../knowledge/types.ts';
import { convertCooldown } from '../policy/convert.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { readPolicyFile } from '../policy/file.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { formatIssue, parsePolicy } from '../policy/validate.ts';
import { autoTargets } from '../apply/targets.ts';
import { managerName, toolName } from './describe.ts';
import { paint, PLAIN, type Paint } from '../color.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.ts';

type CooldownEntry =
  | { tool: ToolId; ok: true; unit: string; value: number | string; exact: boolean }
  | { tool: ToolId; ok: false; reason: string };

export type PolicyReport =
  | {
      file: string;
      valid: true;
      targets: { mode: 'auto' | 'listed'; tools: ToolId[] };
      cooldown: { minimum: string; tools: CooldownEntry[] } | null;
    }
  | { file: string; valid: false; issues: string[] };

export interface ExplainReport {
  schemaVersion: 1;
  project: Detection;
  policy: PolicyReport | null;
}

function cooldownReport(policy: ResolvedPolicy, tools: readonly ToolId[]): { minimum: string; tools: CooldownEntry[] } | null {
  if (policy.cooldown === undefined) return null;
  const minimum = policy.cooldown.minimum;
  const entries = tools.flatMap((id): CooldownEntry[] => {
    const tool = knowledgeBase.find((entry) => entry.id === id);
    if (tool === undefined) return [];
    const result = convertCooldown(tool, minimum);
    return [
      result.ok
        ? { tool: id, ok: true, unit: result.unit, value: result.value, exact: result.exact }
        : { tool: id, ok: false, reason: result.reason },
    ];
  });
  return { minimum: minimum.text, tools: entries };
}

function policyReport(directory: string, detection: Detection): PolicyReport | null {
  const file = readPolicyFile(directory);
  if (file.status === 'missing') return null;
  if (file.status === 'unreadable') return { file: POLICY_FILE, valid: false, issues: [file.reason] };
  const result = parsePolicy(file.text);
  if (!result.ok) return { file: POLICY_FILE, valid: false, issues: result.issues.map(formatIssue) };
  const targets =
    result.policy.targets === 'auto'
      ? { mode: 'auto' as const, tools: autoTargets(directory, detection).targets }
      : { mode: 'listed' as const, tools: [...result.policy.targets] };
  return { file: POLICY_FILE, valid: true, targets, cooldown: cooldownReport(result.policy, targets.tools) };
}

export function buildReport(directory: string): ExplainReport {
  const project = detectProject(directory);
  return { schemaVersion: 1, project, policy: policyReport(directory, project) };
}

// Readable output

function where(declaration: VersionDeclaration): string {
  const location = declaration.line === undefined ? declaration.file : `${declaration.file}:${declaration.line}`;
  const value = 'version' in declaration ? declaration.version : `from ${declaration.versionFile}`;
  return `${value} (${location}, ${declaration.source})`;
}

function amount(value: number | string, unit: string): string {
  if (typeof value === 'string') return value;
  return `${value} ${value === 1 ? unit.replace(/s$/u, '') : unit}`;
}

function projectLines(project: Detection): string[] {
  const lines = [project.packageManagers.length === 0 ? 'Package managers: none' : 'Package managers:'];
  for (const manager of project.packageManagers) {
    lines.push(`  ${managerName(manager)}`);
    if (manager.versions.length > 0) lines.push(`    versions: ${manager.versions.map(where).join(', ')}`);
    lines.push(`    evidence: ${manager.evidence.map((item) => `${item.file} (${item.kind})`).join(', ')}`);
    if (manager.configFiles.length > 0) lines.push(`    config files: ${manager.configFiles.join(', ')}`);
  }
  if (project.node.versions.length === 0) lines.push('Node.js versions: none declared');
  else lines.push('Node.js versions:', ...project.node.versions.map((version) => `  ${where(version)}`));
  if (project.bots.length === 0) lines.push('Bots: none');
  else lines.push('Bots:', ...project.bots.map((bot) => `  ${toolName(bot.id)}: ${bot.configFiles.join(', ')}`));
  if (project.workspaces === null) {
    lines.push('Workspaces: none');
  } else {
    const packages = project.workspaces.packages.length === 0 ? 'no packages' : project.workspaces.packages.join(', ');
    lines.push(`Workspaces: ${packages} (declared in ${project.workspaces.declarations.map((item) => item.file).join(', ')})`);
  }
  lines.push(`.npmrc files: ${project.npmrcFiles.length === 0 ? 'none' : project.npmrcFiles.join(', ')}`);
  lines.push(`GitHub Actions workflows: ${project.workflows.length === 0 ? 'none' : project.workflows.join(', ')}`);
  if (project.warnings.length === 0) lines.push('Warnings: none');
  else lines.push('Warnings:', ...project.warnings.map((warning) => `  ${warning.code}: ${warning.message}`));
  return lines;
}

function policyLines(policy: PolicyReport | null): string[] {
  if (policy === null) return [`Policy: no ${POLICY_FILE}`];
  if (!policy.valid) return [`Policy (${policy.file}): invalid`, ...policy.issues.map((issue) => `  ${issue}`)];
  const names = policy.targets.tools.map(toolName);
  const lines = [
    `Policy (${policy.file}):`,
    `  targets: ${names.length === 0 ? 'none' : names.join(', ')} (${policy.targets.mode === 'auto' ? 'detected' : 'listed'})`,
  ];
  if (policy.cooldown === null) return [...lines, '  cooldown: not managed'];
  lines.push(`  cooldown ${policy.cooldown.minimum}:`);
  for (const entry of policy.cooldown.tools) {
    const name = toolName(entry.tool);
    lines.push(
      entry.ok
        ? `    ${name}: ${amount(entry.value, entry.unit)}${entry.exact ? '' : ' (rounded up)'}`
        : `    ${name}: cannot apply: ${entry.reason}`,
    );
  }
  return lines;
}

/** Section headings (unindented lines up to their first colon) in bold, "cannot apply" and "invalid" in yellow. */
function paintReport(lines: readonly string[], colors: Paint): string[] {
  return lines.map((line) => {
    const marked = line.replace(/: (cannot apply|invalid)(?=:|$)/u, (_match, word: string) => `: ${colors.yellow(word)}`);
    return /^\S/u.test(marked) ? marked.replace(/^[^:]+:/u, (heading) => colors.bold(heading)) : marked;
  });
}

export function renderReport(report: ExplainReport, colors: Paint = PLAIN): string {
  return `${paintReport([...projectLines(report.project), '', ...policyLines(report.policy)], colors).join('\n')}\n`;
}

export function explain(directory: string | undefined, json: boolean, io: CliIo): number {
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;
  const report = buildReport(absolute);
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, paint(io.colors?.stdout)));
  return report.policy !== null && !report.policy.valid ? EXIT_FAILURE : EXIT_OK;
}
