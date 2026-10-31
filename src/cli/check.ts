// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one, up to the root of the repository), else the default policy of
// `depcurfew init`. Packages are looked up in the registry given with --registry, else the one the project's or the
// user's .npmrc sets, else the public npm registry; pypi: packages in the index given with --index, else PyPI. Exit code
// 1 when any package breaks the policy or cannot be checked, 2 for a usage error such as a --dir that does not exist;
// in hook mode the decision goes to stdout as JSON and the exit code is 0.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { checkSpecs, type PackageReport } from '../check/index.ts';
import { isPythonSpec } from '../check/python.ts';
import { blockingExitCode, decide, formatDecision, readHookEvent, reasonText, requestedSpecs } from '../check/hook.ts';
import { defaultRegistry, type FetchLike, isLinkLocal } from '../check/registry.ts';
import { PopularNames } from '../check/similar.ts';
import { Repository } from '../detect/repository.ts';
import { iniEntries } from '../doctor/settings.ts';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { NpmVersionSelectionKnowledge, RegistryConfigKnowledge } from '../knowledge/types.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { popularPythonPackages } from '../knowledge/popular-python.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { findPolicyDirectory } from '../policy/file.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePolicy } from '../policy/validate.ts';
import { paint, type Paint } from '../color.ts';
import { printable, withoutCredentials } from '../printable.ts';
import { checkDirectory, policyInputError, reportInputError, type InputError } from './directory.ts';
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
  /** The Python package index for pypi: packages. */
  index?: string | undefined;
  dir: string | undefined;
  hook: string | undefined;
}

function defaultPolicy(): ResolvedPolicy {
  const result = parsePolicy(renderPolicy(DEFAULT_POLICY));
  if (!result.ok) throw new Error('the default policy is invalid');
  return result.policy;
}

/** A setting of an .npmrc and where it is written, for messages: registry= in .npmrc, line 3. */
interface NpmrcSetting {
  value: string;
  where: string;
}

interface Registries {
  /** The registry .npmrc sets for all packages. */
  registry: NpmrcSetting | undefined;
  /** Registries .npmrc assigns to scopes. */
  scopes: Map<string, string>;
  /** The dist-tag .npmrc makes npm prefer (tag=next). */
  tag: NpmrcSetting | undefined;
}

/** The registries and the dist-tag the user's and the project's .npmrc set (registry=url, @scope:registry=url, tag=…); the project's win. */
function npmrcRegistries(directory: string, home: string): Registries {
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  const result: Registries = { registry: undefined, scopes: new Map(), tag: undefined };
  if (npm === undefined) return result;
  const tagKey = npm.extra?.['versionSelection'] === undefined ? undefined : (values(npm.extra['versionSelection'])[0] as NpmVersionSelectionKnowledge | undefined)?.tagKey;
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
  const files = [
    { text: user, file: fact.userFile },
    { text: new Repository(directory).readText(fact.file) ?? '', file: fact.file },
  ];
  for (const { text, file } of files) {
    for (const { key, value, line } of iniEntries(text)) {
      const where = `${key}= in ${file}, line ${line}`;
      // A user name and password in a registry URL are neither sent (fetch refuses them anyway) nor shown.
      if (key === fact.key) result.registry = { value: withoutCredentials(value), where };
      else if (tagKey !== undefined && key === tagKey) result.tag = { value, where };
      else if (key.startsWith('@') && key.endsWith(fact.scopeKeySuffix)) result.scopes.set(key.slice(0, -fact.scopeKeySuffix.length), withoutCredentials(value));
    }
  }
  return result;
}

/** The npm registry to ask and where it comes from; `where` is undefined for the public registry. */
function registryOf(flags: CheckFlags, registries: Registries): { url: string; where: string | undefined } {
  const url = flags.registry === undefined ? (registries.registry?.value ?? defaultRegistry()) : withoutCredentials(flags.registry);
  const normalized = (text: string) => text.replace(/\/+$/u, '').toLowerCase();
  if (normalized(url) === normalized(defaultRegistry())) return { url, where: undefined };
  return { url, where: flags.registry === undefined ? (registries.registry?.where ?? 'the configuration') : '--registry' };
}

/** What to say about a registry other than the public one: a malicious .npmrc could name any. */
function registryNote(registry: { url: string; where: string | undefined }): string | undefined {
  if (registry.where === undefined) return undefined;
  let host = '';
  try {
    host = new URL(registry.url).hostname;
  } catch {
    // An invalid URL is reported by the lookup itself.
  }
  // A link-local registry is not asked at all (fetchSameOrigin), so the packages were not looked up there.
  return isLinkLocal(host)
    ? `npm packages would be looked up in ${registry.url} (${registry.where}), which depcurfew does not ask`
    : `npm packages were looked up in ${registry.url} (${registry.where}), not in the public npm registry`;
}

function load(start: string, home: string): { policy: ResolvedPolicy; file: string | undefined; registries: Registries } {
  const directory = findPolicyDirectory(start);
  const policy = directory === undefined ? undefined : loadPolicyIfPresent(directory);
  return {
    policy: policy ?? defaultPolicy(),
    file: directory === undefined ? undefined : join(directory, POLICY_FILE),
    registries: npmrcRegistries(directory ?? resolve(start), home),
  };
}

/** A path as the JSON of every command gives it: relative to the directory the command works on, with / separators. */
function shownPath(start: string, file: string): string {
  return relative(start, file).split(sep).join('/');
}

function render(reports: readonly PackageReport[], colors: Paint): string {
  const lines: string[] = [];
  for (const report of reports) {
    // Python versions are written name==version, as pip takes them.
    // Names, versions, deprecation messages and scripts come from the registry: control characters are shown as text.
    const label = printable(report.version === undefined || report.name === undefined ? report.spec : `${report.name}${isPythonSpec(report.spec) ? '==' : '@'}${report.version}`);
    if (report.findings.length === 0) {
      lines.push(`${colors.bold(label)}: ${colors.green('ok')}${report.publishedAt === undefined ? '' : ` (published ${printable(report.publishedAt.slice(0, 10))})`}`);
      continue;
    }
    lines.push(`${colors.bold(label)}:`);
    for (const finding of report.findings) {
      const level = finding.level === 'error' ? colors.bold(colors.red('error:')) : colors.yellow('warning:');
      lines.push(`  ${level} ${printable(finding.message)}`, `    ${colors.green('fix:')} ${printable(finding.fix)}`);
    }
  }
  const errors = reports.filter((report) => report.findings.some((finding) => finding.level === 'error')).length;
  const warnings = reports.filter((report) => report.findings.some((finding) => finding.level === 'warning')).length;
  lines.push('', `${reports.length} ${reports.length === 1 ? 'package' : 'packages'}: ${errors} with errors, ${warnings} with warnings`);
  return `${lines.join('\n')}\n`;
}

/** Popular Python projects by normalized name, so that names differing only in case or separators are the same. */
function popularPython(): PopularNames {
  return new PopularNames((values(popularPythonPackages)[0] ?? []).map(normalizePythonName));
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
    const { specs, unreadable } = requestedSpecs(event.command, event.shell);
    if (specs.length === 0 && unreadable === undefined) return EXIT_OK;
    const loaded = load(flags.dir ?? event.cwd ?? process.cwd(), dependencies.home?.() ?? homedir());
    const registry = registryOf(flags, loaded.registries);
    const reports = await checkSpecs(specs, {
      policy: loaded.policy,
      fetch: dependencies.fetch,
      now: dependencies.now(),
      registry: registry.url,
      popular: new PopularNames(values(popularPackages)[0] ?? []),
      popularPython: popularPython(),
      scopeRegistries: loaded.registries.scopes,
      ...(flags.index === undefined ? {} : { index: withoutCredentials(flags.index) }),
      ...(loaded.registries.tag === undefined ? {} : { defaultTag: loaded.registries.tag.value }),
      scriptBodies: false,
    });
    // Say which registry answered when it is not the public one, if an npm package was looked up there.
    const scopeOf = (name: string) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '');
    const lookedUp = reports.some((report) => report.kind === 'registry' && !isPythonSpec(report.spec) && report.name !== undefined && !loaded.registries.scopes.has(scopeOf(report.name)));
    const note = lookedUp ? registryNote(registry) : undefined;
    io.stdout(formatDecision(decide(reports, unreadable, note === undefined ? [] : [`${note}.`])) ?? '');
  } catch (error) {
    io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(messageOf(error))}` }) ?? '');
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
  // The same error shape as apply --json; nothing is checked without a directory or with a policy that cannot be used.
  const failed = (policy: string | null, error: InputError, code: number): number => {
    if (flags.json) io.stdout(`${JSON.stringify({ schemaVersion: 1, policy, packages: [], notices: [], errors: [error] }, null, 2)}\n`);
    else reportInputError(error, io);
    return code;
  };
  const target = checkDirectory(flags.dir);
  if (!target.ok) return failed(null, target.error, EXIT_USAGE);
  const start = target.directory;
  let loaded: ReturnType<typeof load>;
  try {
    loaded = load(start, dependencies.home?.() ?? homedir());
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    const directory = findPolicyDirectory(start);
    const file = directory === undefined ? POLICY_FILE : shownPath(start, join(directory, POLICY_FILE));
    return failed(file, policyInputError(error, file), EXIT_FAILURE);
  }
  const registry = registryOf(flags, loaded.registries);
  const tag = loaded.registries.tag;
  const notices = [
    ...(loaded.file === undefined ? [{ message: `no ${POLICY_FILE} found; checking against the default policy of depcurfew init (depcurfew init writes it)` }] : []),
    ...(specs.some((spec) => !isPythonSpec(spec)) && registryNote(registry) !== undefined ? [{ message: registryNote(registry) as string }] : []),
    ...(tag === undefined || !specs.some((spec) => !isPythonSpec(spec)) ? [] : [{ message: `npm prefers the dist-tag "${tag.value}" (${tag.where}) for packages named without a version or with a range` }]),
  ];
  // With --json the notes go into the document, so that stderr stays empty for programs.
  if (!flags.json) for (const notice of notices) io.stderr(`note: ${printable(notice.message)}\n`);
  const reports = await checkSpecs(specs, {
    policy: loaded.policy,
    fetch: dependencies.fetch,
    now: dependencies.now(),
    registry: registry.url,
    popular: new PopularNames(values(popularPackages)[0] ?? []),
    popularPython: popularPython(),
    scopeRegistries: loaded.registries.scopes,
    ...(flags.index === undefined ? {} : { index: withoutCredentials(flags.index) }),
    ...(tag === undefined ? {} : { defaultTag: tag.value }),
  });
  const policy = loaded.file === undefined ? null : shownPath(start, loaded.file);
  io.stdout(flags.json ? `${JSON.stringify({ schemaVersion: 1, policy, packages: reports, notices, errors: [] }, null, 2)}\n` : render(reports, paint(io.colors?.stdout)));
  return reports.some((report) => report.findings.some((finding) => finding.level === 'error')) ? EXIT_FAILURE : EXIT_OK;
}
