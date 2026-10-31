// `depcurfew check --hook claude-code`: a Claude Code PreToolUse hook for the tools that run shell commands (Bash,
// PowerShell, Monitor). It reads the event from stdin,
// finds the packages the command would install or run, checks them and answers with a decision: deny when a package
// breaks the policy, ask when depcurfew cannot tell (an unreadable command, a look-alike name, a registry it cannot
// reach), and nothing when everything checks out, which leaves the call to Claude Code's normal permission flow.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import { printable, withoutCredentials } from '../printable.ts';
import type { ClaudeCodeHooksKnowledge, ClaudeCodeShellTool } from '../knowledge/types.ts';
import { scanCommandLine, TOO_MANY, unreadableFix, type ScanOptions } from './command.ts';
import type { CheckFinding, CheckRequest, FindingCode, PackageReport } from './findings.ts';

/** Findings that break the policy outright; other errors only mean that depcurfew cannot vouch for the package. */
const DENY: ReadonlySet<FindingCode> = new Set(['forbidden-source', 'not-found', 'no-version', 'too-young', 'install-scripts', 'quarantined']);

export type HookDecision = { decision: 'deny' | 'ask'; reason: string } | { decision: 'none' };

export interface HookEvent {
  command: string;
  cwd: string | undefined;
  /** The shell of the tool: a POSIX shell for Bash and Monitor (Git Bash on Windows), PowerShell for the PowerShell tool. */
  shell: NonNullable<ScanOptions['shell']>;
}

function facts(): ClaudeCodeHooksKnowledge {
  const fact = values(environment.claudeCode.hooks)[0];
  if (fact === undefined) throw new Error('the knowledge base has no Claude Code hooks fact');
  return fact;
}

/** The tools whose events carry a shell command. */
export function shellTools(): readonly ClaudeCodeShellTool[] {
  return values(environment.claudeCode.shellTools)[0] ?? [];
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

/**
 * The shell command of a PreToolUse event for a tool that runs one; undefined for any other event or tool, and for an
 * event without a command (a Monitor watch of a WebSocket).
 */
export function readHookEvent(input: string): HookEvent | undefined {
  const hooks = facts();
  const event = JSON.parse(input) as unknown;
  const tool = shellTools().find((entry) => entry.tool === field(event, hooks.input.tool));
  if (field(event, hooks.input.event) !== hooks.event || tool === undefined) return undefined;
  const shell = tool.shell === 'powershell' ? 'powershell' : 'posix';
  const command = field(event, hooks.input.command);
  const cwd = field(event, hooks.input.cwd);
  return typeof command === 'string' ? { command, cwd: typeof cwd === 'string' ? cwd : undefined, shell } : undefined;
}

/** The most characters of one finding, command or note in a reason, and of the whole reason. */
const PART_LIMIT = 400;
const REASON_LIMIT = 4000;
const CUT = '\n(cut short)';

/**
 * Text for a reason from a registry, a repository or the command: the model reads a deny reason and the user sees an
 * ask reason in the permission prompt, so control and bidirectional characters are shown as visible text (a line
 * break cannot start a line that looks like depcurfew's own), credentials in URLs are left out, and it is cut short.
 */
export function reasonText(text: string): string {
  const shown = printable(withoutCredentials(text));
  return shown.length > PART_LIMIT ? `${shown.slice(0, PART_LIMIT - 1)}…` : shown;
}

/** A whole reason of at most REASON_LIMIT characters: the lines between `head` and `tail` are cut short, never what to do. */
function limited(head: string, lines: readonly string[], tail = ''): string {
  const body = lines.join('\n');
  const room = REASON_LIMIT - head.length - tail.length;
  return `${head}${body.length > room ? `${body.slice(0, room - CUT.length)}${CUT}` : body}${tail}`;
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
  return `- ${reasonText(label(report))}: ${reasonText(finding.message)}${finding.fix.includes('depcurfew.json') ? '' : `. Fix: ${reasonText(finding.fix)}`}`;
}

/** The decision for the checked packages of one command; `notes` (such as the registry that was asked) end the reason. */
export function decide(reports: readonly PackageReport[], unreadable: string | undefined, notes: readonly string[] = []): HookDecision {
  const errors = reports.flatMap((report) => report.findings.filter((finding) => finding.level === 'error').map((finding) => ({ report, finding })));
  const denied = errors.filter(({ finding }) => DENY.has(finding.code));
  const shownNotes = notes.map(reasonText);
  if (denied.length > 0) {
    const advice = '\nChoose another package or version. Only the user may change depcurfew.json: ask them instead of editing it.';
    return {
      decision: 'deny',
      reason: limited(
        "depcurfew blocked this command because it breaks the project's supply-chain policy (depcurfew.json):\n",
        denied.map(({ report, finding }) => line(report, finding)),
        `${advice}${shownNotes.map((note) => `\n${note}`).join('')}`,
      ),
    };
  }
  const doubts = [
    ...(unreadable === undefined ? [] : [`- ${reasonText(unreadable)}. Fix: ${unreadableFix(unreadable)}`]),
    ...errors.map(({ report, finding }) => line(report, finding)),
  ];
  if (doubts.length > 0) return { decision: 'ask', reason: limited('depcurfew cannot vouch for what this command installs:\n', [...doubts, ...shownNotes]) };
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
export function requestedSpecs(command: string, shell: HookEvent['shell'] = 'posix'): { specs: CheckRequest[]; unreadable: string | undefined } {
  const scan = scanCommandLine(command, { shell });
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
