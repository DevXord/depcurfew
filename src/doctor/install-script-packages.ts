// npm packages whose install scripts depcurfew knows (decision D-127): esbuild and fsevents work without them, and
// lefthook's only installs the git hooks of the repository, which lefthook says to do after each clone for projects
// that do not use its script (decision D-135). The facts come from environment.installScriptPackages, with the
// releases they were read at, and hold for those packages from a registry only; init, doctor and apply take their
// texts from here, so the three say the same thing. Also where npm leaves out optional dependencies, which a package
// that takes its binary from one needs once its install script is denied.
import { extraOf, firstFile, isRecord } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import { jobLabel } from '../detect/workflows.ts';
import type { Detection, ToolCommand } from '../detect/types.ts';
import { environment } from '../knowledge/environment.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { InstallScriptPackageKnowledge, OmitOptionalKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { matchesPattern } from './allow-lists.ts';
import type { LockEntry } from './lockfiles.ts';
import { iniEntries } from './settings.ts';

/** Every known package, in the order of the knowledge base. */
export function knownPackages(): InstallScriptPackageKnowledge[] {
  return Object.values(environment.installScriptPackages).flatMap((fact) => evidenceOf(fact).map((evidence) => evidence.value));
}

/** The known package of that name, if any. */
export function knownPackage(name: string): InstallScriptPackageKnowledge | undefined {
  return knownPackages().find((entry) => entry.name === name);
}

/**
 * The known package a lockfile entry is: only that package from a registry under its own name (decision D-135). What
 * depcurfew read about its install script does not hold for a git, URL or local source of the same name, nor for an
 * entry whose resolved URL is the tarball of another package.
 */
export function knownPackageOf(entry: LockEntry): InstallScriptPackageKnowledge | undefined {
  return entry.source === 'registry' && entry.registryName === undefined ? knownPackage(entry.name) : undefined;
}

/** " (depcurfew checked esbuild 0.28.2; the lockfile has 0.21.5)" when the locked version is not one that was read. */
export function versionNote(known: InstallScriptPackageKnowledge, version: string | undefined, where = 'the lockfile'): string {
  if (version === undefined || known.versions.includes(version)) return '';
  return ` (depcurfew checked ${known.name} ${known.versions.join(', ')}; ${where} has ${version}, so check that it works the same)`;
}

/**
 * Why the package can do without its install scripts, as a clause of a doctor finding: "esbuild does not need them: it
 * only puts ...", or for a project task "they only do a task of the project: it runs lefthook install, ...".
 */
export function scriptsPurpose(known: InstallScriptPackageKnowledge): string {
  return `${known.kind === 'project-task' ? 'they only do a task of the project' : `${known.name} does not need them`}: ${known.does}`;
}

/** What changes without the script, as a sentence part: "without it nothing changes", with what it needs then. */
export function withoutScript(known: InstallScriptPackageKnowledge): string {
  return `without it ${known.withoutScript}${known.needsOptionalDependencies ? '; the package then needs its optional dependencies, which hold its binary' : ''}`;
}

/** "keep optional dependencies installed (no omit=optional in .npmrc, ...)", with npm's settings where npm installs. */
function keepOptional(tool: ToolKnowledge | undefined, capital = false): string {
  const keep = `${capital ? 'K' : 'k'}eep optional dependencies installed`;
  return tool !== undefined && omitFacts(tool) !== undefined ? `${keep} (no omit=optional in .npmrc, no --omit=optional or --no-optional on the install)` : keep;
}

/**
 * What to do about a known package that has no entry in installScripts: add it to installScripts.deny, and for a
 * project task also do that task the way the package documents it for projects that do not use its script.
 */
export function denyFix(known: InstallScriptPackageKnowledge, tool: ToolKnowledge | undefined): string {
  const deny = `Add ${known.name} to installScripts.deny in ${POLICY_FILE}`;
  if (known.kind === 'project-task') return `${deny}, and ${projectTaskStep(known)}`;
  return known.needsOptionalDependencies
    ? `${deny}, and ${keepOptional(tool)}: ${known.name} works without its install script then`
    : `${deny}: ${known.name} works without its install script, and ${known.withoutScript}`;
}

/** What to keep doing for a package init denied: optional dependencies installed, or the project task done by hand. */
export function keepFix(known: InstallScriptPackageKnowledge, tool: ToolKnowledge | undefined): string {
  const allow = `move ${known.name} to installScripts.allow in ${POLICY_FILE} only if you want its script to run`;
  if (known.kind === 'project-task') {
    const step = projectTaskStep(known);
    return `${step.charAt(0).toUpperCase()}${step.slice(1)}, or ${allow}`;
  }
  return known.needsOptionalDependencies ? `${keepOptional(tool, true)}, or ${allow}` : `Leave it in installScripts.deny; ${allow}`;
}

/**
 * How the project does the task of a project-task package itself, as the package documents it for projects that do
 * not use its install script (decision D-135): lefthook says to run lefthook install after cloning. A prepare script
 * would run it on every install, also in CI, where lefthook's postinstall script does nothing.
 */
export function projectTaskStep(known: InstallScriptPackageKnowledge): string {
  const command = known.projectStep?.command ?? known.name;
  const event = known.script.split(':', 1)[0] ?? 'install';
  return `run ${command} after each clone of the repository, as the ${known.name} documentation says for projects that do not use its ${event} script`;
}

/** A place where npm leaves out optional dependencies: the project .npmrc, or an install of a CI job or a Dockerfile. */
export interface OmitPlace {
  location: { file: string; line?: number };
  /** The .npmrc entry that does it (omit=optional), absent for an install. */
  entry?: string;
  /** "omit=optional in .npmrc (line 2)", "the npm install in job build of .github/workflows/ci.yml (line 14)". */
  text: string;
}

function omitFacts(tool: ToolKnowledge): OmitOptionalKnowledge | undefined {
  if (tool.extra?.['omitOptional'] === undefined) return undefined;
  const value = extraOf(tool, 'omitOptional', isRecord) as unknown as OmitOptionalKnowledge;
  return isRecord(value.omit) && isRecord(value.alias) && isRecord(value.include) ? value : undefined;
}

/**
 * What the project .npmrc says about optional dependencies, as npm reads it: each of omit, include and optional is one
 * key, the last line winning (`omit[]` lines add to the list); include=optional wins over an omit.
 */
function npmrcOmission(text: string, facts: OmitOptionalKnowledge): { omitted: boolean; included: boolean; line?: number; entry?: string } {
  // `at`: the entry of the list that names optional, which messages and fixes quote (decision D-135: never another
  // value of the file, which could be any text).
  const lists = new Map<string, { values: string[]; at?: { line: number; text: string } }>();
  let optional: { value: string; line: number } | undefined;
  for (const entry of iniEntries(text)) {
    const list = entry.key.endsWith('[]');
    const key = list ? entry.key.slice(0, -2) : entry.key;
    if (key === facts.alias.setting) optional = { value: entry.value, line: entry.line };
    if (key !== facts.omit.setting && key !== facts.include.setting) continue;
    const known = lists.get(key);
    const at = entry.value === facts.omit.value ? { line: entry.line, text: `${entry.key}=${entry.value}` } : list ? known?.at : undefined;
    lists.set(key, { values: list && known !== undefined ? [...known.values, entry.value] : [entry.value], ...(at === undefined ? {} : { at }) });
  }
  const omit = lists.get(facts.omit.setting);
  const included = lists.get(facts.include.setting)?.values.includes(facts.omit.value) === true || optional?.value === 'true';
  if (omit?.values.includes(facts.omit.value) === true) return { omitted: !included, included, ...(omit.at === undefined ? {} : { line: omit.at.line, entry: omit.at.text }) };
  if (optional?.value === String(facts.alias.off)) return { omitted: !included, included, line: optional.line, entry: `${facts.alias.setting}=${optional.value}` };
  return { omitted: false, included };
}

/** "the npm install in job build of .github/workflows/ci.yml (line 14)" */
function commandPlace(command: ToolCommand, where: string, file: string): OmitPlace {
  return { location: { file, line: command.line }, text: `the npm install ${where} (line ${command.line})` };
}

/**
 * Where npm leaves out optional dependencies for this directory (decision D-127): the project .npmrc (omit=optional,
 * omit[]=optional, optional=false), and the npm installs of CI jobs and Dockerfiles whose command line or variables do
 * (--omit=optional, --no-optional, NPM_CONFIG_OMIT=optional), unless include=optional keeps them.
 */
export function optionalOmissions(repository: Repository, detection: Detection, npm: ToolKnowledge): OmitPlace[] {
  const facts = omitFacts(npm);
  if (facts === undefined) return [];
  const file = firstFile(npm.cooldown.configFiles) ?? '.npmrc';
  const npmrc = npmrcOmission(repository.readText(file) ?? '', facts);
  const places: OmitPlace[] = [];
  if (npmrc.omitted && npmrc.entry !== undefined) {
    places.push({ location: { file, ...(npmrc.line === undefined ? {} : { line: npmrc.line }) }, entry: npmrc.entry, text: `${npmrc.entry} in ${file}${npmrc.line === undefined ? '' : ` (line ${npmrc.line})`}` });
  }
  // The installs say what npm does with the .npmrc of the root under their command line and variables, key by key:
  // include=optional there wins over --omit=optional, but not over a command line that sets include (decision D-143).
  const omits = (command: ToolCommand) => command.tool === 'npm' && command.kind === 'install' && command.optionalDependencies === 'omitted';
  for (const job of detection.jobs) {
    for (const command of job.commands.filter(omits)) places.push(commandPlace(command, `in ${jobLabel(job.id, job.line)} of ${job.file}`, job.file));
  }
  for (const dockerfile of detection.dockerfiles) {
    for (const stage of dockerfile.stages) {
      for (const command of stage.commands.filter(omits)) places.push(commandPlace(command, `in ${dockerfile.file}`, dockerfile.file));
    }
  }
  return places;
}

/** The denied packages that need their optional dependencies: known ones that a pattern of installScripts.deny covers. */
export function deniedNeedingOptional(deny: readonly string[]): InstallScriptPackageKnowledge[] {
  return knownPackages().filter((known) => known.needsOptionalDependencies && deny.some((pattern) => matchesPattern(known.name, pattern)));
}

/** The warning, in doctor and apply, for a denied package that needs optional dependencies npm leaves out. */
export function omittedOptionalText(known: InstallScriptPackageKnowledge, place: OmitPlace): { message: string; fix: string } {
  const allow = `move ${known.name} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing its install script`;
  return {
    message: `${known.name} is in installScripts.deny, so it can take its binary only from its optional dependencies, but ${place.text} leaves them out, so ${known.name} cannot find its binary after such an install`,
    fix:
      place.entry === undefined
        ? `Remove --omit=optional, --no-optional, npm_config_omit=optional and npm_config_optional=false from that install, or add --include=optional to it; or ${allow}`
        : `Remove ${place.entry} from ${place.location.file} so that npm installs optional dependencies, or ${allow}`,
  };
}
