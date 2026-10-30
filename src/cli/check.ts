// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one), else the default policy of `depcurfew init`. Packages are looked up in
// the registry given with --registry, else the one the project's or the user's .npmrc sets, else the public npm registry. Exit code 1 when any
// package breaks the policy or cannot be checked; in hook mode the decision goes to stdout as JSON and the exit code is 0.
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadPolicyIfPresent, PolicyError, policyErrorFix } from '../apply/index.ts';
import { checkSpecs, type PackageReport } from '../check/index.ts';
import { blockingExitCode, decide, formatDecision, readHookEvent, requestedSpecs } from '../check/hook.ts';
import { defaultRegistry, type FetchLike } from '../check/registry.ts';
import { PopularNames } from '../check/similar.ts';
import { Repository } from '../detect/repository.ts';
import { iniEntries } from '../doctor/settings.ts';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { RegistryConfigKnowledge } from '../knowledge/types.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePolicy } from '../policy/validate.ts';
import { paint, type Paint } from '../color.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export const HOOKS = ['claude-code'] as const;

export interface CheckDependencies {
  fetch: FetchLike;
  now: () => Date;
  /** The whole of stdin, for hook mode. */
  stdin: () => Promise<string>;
  /** The user's home directory, with the user's .npmrc. */
  home?: () => string;
}

export interface CheckFlags {
  json: boolean;
  registry: string | undefined;
  dir: string | undefined;
  hook: string | undefined;
}

/** The directory with the depcurfew.json that applies to `start`: itself or the nearest parent. */
function policyDirectory(start: string): string | undefined {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    if (lstatSync(join(directory, POLICY_FILE), { throwIfNoEntry: false }) !== undefined) return directory;
    if (dirname(directory) === directory) return undefined;
  }
}

function defaultPolicy(): ResolvedPolicy {
  const result = parsePolicy(renderPolicy(DEFAULT_POLICY));
  if (!result.ok) throw new Error('the default policy is invalid');
  return result.policy;
}

interface Registries {
  /** The registry .npmrc sets for all packages. */
  registry: string | undefined;
  /** Registries .npmrc assigns to scopes. */
  scopes: Map<string, string>;
}

/** The registries the user's and the project's .npmrc set (registry=url, @scope:registry=url); the project's win. */
function npmrcRegistries(directory: string, home: string): Registries {
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  const result: Registries = { registry: undefined, scopes: new Map() };
  if (npm === undefined) return result;
  const fact = extraOf(
    npm,
    'registryConfig',
    (value): value is RegistryConfigKnowledge =>
      isRecord(value) && typeof value['file'] === 'string' && typeof value['userFile'] === 'string' && typeof value['key'] === 'string' && typeof value['scopeKeySuffix'] === 'string',
  );
  let user = '';
  try {
    user = readFileSync(join(home, fact.userFile.replace(/^~[/\\]/u, '')), 'utf8');
  } catch {
    // No user configuration.
  }
  for (const text of [user, new Repository(directory).readText(fact.file) ?? '']) {
    for (const { key, value } of iniEntries(text)) {
      if (key === fact.key) result.registry = value;
      else if (key.startsWith('@') && key.endsWith(fact.scopeKeySuffix)) result.scopes.set(key.slice(0, -fact.scopeKeySuffix.length), value);
    }
  }
  return result;
}

function load(start: string, home: string): { policy: ResolvedPolicy; file: string | undefined; registries: Registries } {
  const directory = policyDirectory(start);
  const policy = directory === undefined ? undefined : loadPolicyIfPresent(directory);
  return {
    policy: policy ?? defaultPolicy(),
    file: directory === undefined ? undefined : join(directory, POLICY_FILE),
    registries: npmrcRegistries(directory ?? resolve(start), home),
  };
}

function render(reports: readonly PackageReport[], colors: Paint): string {
  const lines: string[] = [];
  for (const report of reports) {
    const label = report.version === undefined || report.name === undefined ? report.spec : `${report.name}@${report.version}`;
    if (report.findings.length === 0) {
      lines.push(`${colors.bold(label)}: ${colors.green('ok')}${report.publishedAt === undefined ? '' : ` (published ${report.publishedAt.slice(0, 10)})`}`);
      continue;
    }
    lines.push(`${colors.bold(label)}:`);
    for (const finding of report.findings) {
      const level = finding.level === 'error' ? colors.bold(colors.red('error:')) : colors.yellow('warning:');
      lines.push(`  ${level} ${finding.message}`, `    ${colors.green('fix:')} ${finding.fix}`);
    }
  }
  const errors = reports.filter((report) => report.findings.some((finding) => finding.level === 'error')).length;
  const warnings = reports.filter((report) => report.findings.some((finding) => finding.level === 'warning')).length;
  lines.push('', `${reports.length} ${reports.length === 1 ? 'package' : 'packages'}: ${errors} with errors, ${warnings} with warnings`);
  return `${lines.join('\n')}\n`;
}

function messageOf(error: unknown): string {
  if (error instanceof PolicyError) return [error.text, ...error.issues].join('; ');
  return error instanceof Error ? error.message : String(error);
}

async function hook(flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  let event: ReturnType<typeof readHookEvent>;
  try {
    event = readHookEvent(await dependencies.stdin());
  } catch (error) {
    // Without the event depcurfew cannot tell what would run; this exit code blocks the call even without onFailure.
    io.stderr(`depcurfew: cannot read the hook event: ${messageOf(error)}\n`);
    return blockingExitCode();
  }
  if (event === undefined) return EXIT_OK;
  try {
    const { specs, unreadable } = requestedSpecs(event.command);
    if (specs.length === 0 && unreadable === undefined) return EXIT_OK;
    const loaded = load(flags.dir ?? event.cwd ?? process.cwd(), dependencies.home?.() ?? homedir());
    const reports = await checkSpecs(specs, {
      policy: loaded.policy,
      fetch: dependencies.fetch,
      now: dependencies.now(),
      registry: flags.registry ?? loaded.registries.registry ?? defaultRegistry(),
      popular: new PopularNames(values(popularPackages)[0] ?? []),
      scopeRegistries: loaded.registries.scopes,
    });
    io.stdout(formatDecision(decide(reports, unreadable)) ?? '');
  } catch (error) {
    io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${messageOf(error)}` }) ?? '');
  }
  return EXIT_OK;
}

export async function check(specs: readonly string[], flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  if (flags.hook !== undefined) {
    if (!(HOOKS as readonly string[]).includes(flags.hook)) {
      io.stderr(`depcurfew: unknown hook '${flags.hook}'; supported: ${HOOKS.join(', ')}\nRun 'depcurfew check --help' for usage.\n`);
      return EXIT_USAGE;
    }
    if (specs.length > 0) {
      io.stderr("depcurfew: '--hook' reads the command from stdin and takes no packages\nRun 'depcurfew check --help' for usage.\n");
      return EXIT_USAGE;
    }
    return hook(flags, io, dependencies);
  }
  if (specs.length === 0) {
    io.stderr("depcurfew: 'check' needs at least one package, e.g. depcurfew check lodash@4\nRun 'depcurfew check --help' for usage.\n");
    return EXIT_USAGE;
  }
  const start = flags.dir ?? process.cwd();
  let loaded: ReturnType<typeof load>;
  try {
    loaded = load(start, dependencies.home?.() ?? homedir());
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    if (flags.json) {
      // The same error shape as apply --json; nothing is checked against a policy that cannot be used.
      const directory = policyDirectory(start);
      const file = directory === undefined ? POLICY_FILE : join(directory, POLICY_FILE);
      const failure = {
        code: error.code,
        level: 'error',
        location: { file },
        message: error.message,
        fix: policyErrorFix(error),
        ...(error.issues.length === 0 ? {} : { issues: error.issues }),
      };
      io.stdout(`${JSON.stringify({ schemaVersion: 1, policy: file, packages: [], notices: [], errors: [failure] }, null, 2)}\n`);
      return EXIT_FAILURE;
    }
    io.stderr(`depcurfew: ${error.text}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`);
    return EXIT_FAILURE;
  }
  const notices = loaded.file === undefined ? [{ message: `no ${POLICY_FILE} found; checking against the default policy of depcurfew init (depcurfew init writes it)` }] : [];
  // With --json the notes go into the document, so that stderr stays empty for programs.
  if (!flags.json) for (const notice of notices) io.stderr(`note: ${notice.message}\n`);
  const reports = await checkSpecs(specs, {
    policy: loaded.policy,
    fetch: dependencies.fetch,
    now: dependencies.now(),
    registry: flags.registry ?? loaded.registries.registry ?? defaultRegistry(),
    popular: new PopularNames(values(popularPackages)[0] ?? []),
    scopeRegistries: loaded.registries.scopes,
  });
  io.stdout(flags.json ? `${JSON.stringify({ schemaVersion: 1, policy: loaded.file ?? null, packages: reports, notices, errors: [] }, null, 2)}\n` : render(reports, paint(io.colors?.stdout)));
  return reports.some((report) => report.findings.some((finding) => finding.level === 'error')) ? EXIT_FAILURE : EXIT_OK;
}
