// `depgate check --hook claude-code`: a Claude Code PreToolUse hook for the Bash tool. It reads the event from stdin,
// finds the packages the command would install or run, checks them and answers with a decision: deny when a package
// breaks the policy, ask when depgate cannot tell (an unreadable command, a look-alike name, a registry it cannot
// reach), and nothing when everything checks out, which leaves the call to Claude Code's normal permission flow.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type { ClaudeCodeHooksKnowledge } from '../knowledge/types.ts';
import { scanCommandLine } from './command.ts';
import type { CheckFinding, FindingCode, PackageReport } from './index.ts';

/** Findings that break the policy outright; other errors only mean that depgate cannot vouch for the package. */
const DENY: ReadonlySet<FindingCode> = new Set(['forbidden-source', 'not-found', 'no-version', 'too-young', 'install-scripts']);

export type HookDecision = { decision: 'deny' | 'ask'; reason: string } | { decision: 'none' };

export interface HookEvent {
  command: string;
  cwd: string | undefined;
}

function facts(): ClaudeCodeHooksKnowledge {
  const fact = values(environment.claudeCode.hooks)[0];
  if (fact === undefined) throw new Error('the knowledge base has no Claude Code hooks fact');
  return fact;
}

function field(object: unknown, path: string): unknown {
  let current = object;
  for (const key of path.split('.')) current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  return current;
}

/** The exit code that makes Claude Code block the tool call, whatever its settings. */
export function blockingExitCode(): number {
  return facts().blockingExitCode;
}

/** The shell command of a PreToolUse event for the Bash tool; undefined for any other event or tool. */
export function readHookEvent(input: string): HookEvent | undefined {
  const hooks = facts();
  const event = JSON.parse(input) as unknown;
  if (field(event, hooks.input.event) !== hooks.event || field(event, hooks.input.tool) !== hooks.shellTool) return undefined;
  const command = field(event, hooks.input.command);
  const cwd = field(event, hooks.input.cwd);
  return typeof command === 'string' ? { command, cwd: typeof cwd === 'string' ? cwd : undefined } : undefined;
}

function line(report: PackageReport, finding: CheckFinding): string {
  return `- ${report.spec}: ${finding.message}`;
}

/** The decision for the checked packages of one command. */
export function decide(reports: readonly PackageReport[], unreadable: string | undefined): HookDecision {
  const errors = reports.flatMap((report) => report.findings.filter((finding) => finding.level === 'error').map((finding) => ({ report, finding })));
  const denied = errors.filter(({ finding }) => DENY.has(finding.code));
  if (denied.length > 0) {
    return {
      decision: 'deny',
      reason: `depgate blocked this command because it breaks the project's supply-chain policy (depgate.json):\n${denied.map(({ report, finding }) => line(report, finding)).join('\n')}\nChoose another package or version, or ask the user to change depgate.json.`,
    };
  }
  const doubts = [...(unreadable === undefined ? [] : [`- ${unreadable}`]), ...errors.map(({ report, finding }) => line(report, finding))];
  if (doubts.length > 0) return { decision: 'ask', reason: `depgate cannot vouch for what this command installs:\n${doubts.join('\n')}` };
  return { decision: 'none' };
}

/** The JSON a hook prints for a decision; undefined when it prints nothing. */
export function formatDecision(decision: HookDecision): string | undefined {
  if (decision.decision === 'none') return undefined;
  const hooks = facts();
  return `${JSON.stringify({
    [hooks.output.container]: {
      [hooks.output.event]: hooks.event,
      [hooks.output.decision]: hooks.decisions[decision.decision],
      [hooks.output.reason]: decision.reason,
    },
  })}\n`;
}

/** Specs to check for a command, without repeats, and why part of it could not be read. */
export function requestedSpecs(command: string): { specs: string[]; unreadable: string | undefined } {
  const scan = scanCommandLine(command);
  return { specs: [...new Set(scan.requests.map((request) => request.spec))], unreadable: scan.unreadable };
}
