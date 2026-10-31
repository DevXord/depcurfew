// `depcurfew check --hook claude-code`: a Claude Code PreToolUse hook for the Bash tool. It reads the event from stdin,
// finds the packages the command would install or run, checks them and answers with a decision: deny when a package
// breaks the policy, ask when depcurfew cannot tell (an unreadable command, a look-alike name, a registry it cannot
// reach), and nothing when everything checks out, which leaves the call to Claude Code's normal permission flow.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type { ClaudeCodeHooksKnowledge } from '../knowledge/types.ts';
import { scanCommandLine, TOO_MANY, unreadableFix } from './command.ts';
import type { CheckFinding, CheckRequest, FindingCode, PackageReport } from './findings.ts';

/** Findings that break the policy outright; other errors only mean that depcurfew cannot vouch for the package. */
const DENY: ReadonlySet<FindingCode> = new Set(['forbidden-source', 'not-found', 'no-version', 'too-young', 'install-scripts', 'quarantined']);

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

/** The spec as the agent wrote it, with what the command changes about the version or the build. */
function label(report: PackageReport): string {
  const notes = [
    ...(report.tag === undefined ? [] : [`tag ${report.tag}`]),
    ...(report.prereleases === undefined ? [] : [report.prereleases === 'allow' ? 'pre-releases allowed' : 'no pre-releases']),
    ...(report.buildFromSource === true ? ['built from source'] : []),
  ];
  return notes.length === 0 ? report.spec : `${report.spec} (${notes.join(', ')})`;
}

/**
 * One finding for the agent. Fixes that change depcurfew.json are left out: the policy is the user's to change, and the
 * reason says to ask them.
 */
function line(report: PackageReport, finding: CheckFinding): string {
  return `- ${label(report)}: ${finding.message}${finding.fix.includes('depcurfew.json') ? '' : `. Fix: ${finding.fix}`}`;
}

/** The decision for the checked packages of one command; `notes` (such as the registry that was asked) end the reason. */
export function decide(reports: readonly PackageReport[], unreadable: string | undefined, notes: readonly string[] = []): HookDecision {
  const errors = reports.flatMap((report) => report.findings.filter((finding) => finding.level === 'error').map((finding) => ({ report, finding })));
  const denied = errors.filter(({ finding }) => DENY.has(finding.code));
  if (denied.length > 0) {
    return {
      decision: 'deny',
      reason: `depcurfew blocked this command because it breaks the project's supply-chain policy (depcurfew.json):\n${denied.map(({ report, finding }) => line(report, finding)).join('\n')}\nChoose another package or version. Only the user may change depcurfew.json: ask them instead of editing it.${notes.map((note) => `\n${note}`).join('')}`,
    };
  }
  const doubts = [
    ...(unreadable === undefined ? [] : [`- ${unreadable}. Fix: ${unreadableFix(unreadable)}`]),
    ...errors.map(({ report, finding }) => line(report, finding)),
  ];
  if (doubts.length > 0) return { decision: 'ask', reason: `depcurfew cannot vouch for what this command installs:\n${[...doubts, ...notes].join('\n')}` };
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

/** How many specs of one command are checked: more would mean as many requests to the registry. */
export const MAX_CHECKED = 50;

/** Specs to check for a command, without repeats and at most MAX_CHECKED, and why part of it could not be read. */
export function requestedSpecs(command: string): { specs: CheckRequest[]; unreadable: string | undefined } {
  const scan = scanCommandLine(command);
  const unique = new Map<string, CheckRequest>();
  for (const { tool, spec, tag, prereleases, buildFromSource } of scan.requests) {
    const request: CheckRequest = {
      spec,
      ...(tag === undefined ? {} : { tag }),
      // tag= in .npmrc is a setting of npm; pnpm, Yarn, Bun and Deno pick the registry's default tag.
      ...(tool === 'npm' ? {} : { ignoresConfigTag: true }),
      ...(prereleases === undefined ? {} : { prereleases }),
      ...(buildFromSource === undefined ? {} : { buildFromSource }),
    };
    unique.set(JSON.stringify(request), request);
  }
  const specs = [...unique.values()];
  if (specs.length <= MAX_CHECKED) return { specs, unreadable: scan.unreadable };
  const tooMany = `the command names ${specs.length} packages and ${TOO_MANY} ${MAX_CHECKED} in one command; the first ${MAX_CHECKED} were checked`;
  return { specs: specs.slice(0, MAX_CHECKED), unreadable: scan.unreadable ?? tooMany };
}
