// npm packages whose install scripts depcurfew knows (decision D-127): esbuild and fsevents work without them, and
// lefthook's only installs the git hooks of the repository, which the project can do in its own prepare script. The
// facts come from environment.installScriptPackages, with the releases they were read at; init, doctor and apply
// take their texts from here, so the three say the same thing. Also where npm leaves out optional dependencies, which
// a package that takes its binary from one needs once its install script is denied.
import { extraOf, firstFile, isRecord } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import type { Detection, ToolCommand } from '../detect/types.ts';
import { environment } from '../knowledge/environment.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { InstallScriptPackageKnowledge, OmitOptionalKnowledge, RootLifecycleScriptsKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { matchesPattern } from './allow-lists.ts';
import { iniEntries, iniValue, readSetting } from './settings.ts';

/** Every known package, in the order of the knowledge base. */
export function knownPackages(): InstallScriptPackageKnowledge[] {
  return Object.values(environment.installScriptPackages).flatMap((fact) => evidenceOf(fact).map((evidence) => evidence.value));
}

/** The known package of that name, if any. */
export function knownPackage(name: string): InstallScriptPackageKnowledge | undefined {
  return knownPackages().find((entry) => entry.name === name);
}

/** " (depcurfew checked esbuild 0.28.2; the lockfile has 0.21.5)" when the locked version is not one that was read. */
export function versionNote(known: InstallScriptPackageKnowledge, version: string | undefined, where = 'the lockfile'): string {
  if (version === undefined || known.versions.includes(version)) return '';
  return ` (depcurfew checked ${known.name} ${known.versions.join(', ')}; ${where} has ${version}, so check that it works the same)`;
}

/** The lifecycle scripts of the project that the tool runs on install whatever its allow-list says, when that is known. */
export function rootScripts(tool: ToolKnowledge | undefined): RootLifecycleScriptsKnowledge | undefined {
  if (tool?.extra?.['rootLifecycleScripts'] === undefined) return undefined;
  const value = extraOf(tool, 'rootLifecycleScripts', isRecord) as unknown as RootLifecycleScriptsKnowledge;
  return Array.isArray(value.events) ? value : undefined;
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
 * project task also run that task in the project's own lifecycle script, where the tool runs it on install
 * (rootLifecycleScripts) and its scripts are not all switched off (`allScriptsOff`, ignore-scripts in .npmrc).
 */
export function denyFix(known: InstallScriptPackageKnowledge, tool: ToolKnowledge | undefined, allScriptsOff?: string): string {
  const deny = `Add ${known.name} to installScripts.deny in ${POLICY_FILE}`;
  if (known.kind === 'project-task') return `${deny}, and ${projectTaskStep(known, tool, allScriptsOff)}`;
  return known.needsOptionalDependencies
    ? `${deny}, and ${keepOptional(tool)}: ${known.name} works without its install script then`
    : `${deny}: ${known.name} works without its install script, and ${known.withoutScript}`;
}

/**
 * What to keep doing for a package init denied: optional dependencies installed, or the project task run in the
 * project's own lifecycle script (`manifest`, the package.json of the project; `scriptsOff`, as for denyFix).
 */
export function keepFix(known: InstallScriptPackageKnowledge, tool: ToolKnowledge | undefined, options: { manifest?: string; scriptsOff?: string } = {}): string {
  const allow = `move ${known.name} to installScripts.allow in ${POLICY_FILE} only if you want its script to run`;
  if (known.kind === 'project-task') {
    const step = projectTaskStep(known, tool, options.scriptsOff, options.manifest);
    return `${step.charAt(0).toUpperCase()}${step.slice(1)}, or ${allow}`;
  }
  return known.needsOptionalDependencies ? `${keepOptional(tool, true)}, or ${allow}` : `Leave it in installScripts.deny; ${allow}`;
}

/** How the project runs the task of a project-task package itself; depcurfew never edits the scripts of package.json. */
export function projectTaskStep(known: InstallScriptPackageKnowledge, tool: ToolKnowledge | undefined, allScriptsOff?: string, manifest = 'package.json'): string {
  const script = known.projectScript;
  const scripts = rootScripts(tool);
  const after = `run ${script?.command ?? known.name} after each clone`;
  if (script === undefined || tool === undefined || scripts === undefined || !scripts.events.includes(script.event)) {
    return `${after} (depcurfew does not know whether ${tool?.name ?? 'the package manager'} runs a ${script?.event ?? 'lifecycle'} script of the project on install)`;
  }
  if (allScriptsOff !== undefined) return `${after}: ${allScriptsOff} also keeps ${tool.name} from running the ${script.event} script of the project`;
  return `add "${script.event}": "${script.command}" to scripts in ${manifest}, which ${tool.name} runs for the project itself on install (its allow-list of dependency scripts does not apply to it; depcurfew does not edit scripts)`;
}

/**
 * The switch in the tool's project configuration that turns every script off (installScripts.disableAll, ignore-scripts
 * in .npmrc), as "ignore-scripts in .npmrc" when it is on; it also stops the lifecycle scripts of the project.
 */
export function allScriptsOffBy(repository: Repository, tool: ToolKnowledge): string | undefined {
  const file = firstFile(tool.cooldown.configFiles);
  const fact = tool.installScripts.disableAll;
  const value = fact.status === 'verified' ? fact.value : undefined;
  const match = file === undefined || typeof value !== 'string' ? null : /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value);
  if (match === null || file === undefined) return undefined;
  const [, key = '', expected] = match;
  const found = readSetting(repository, file, key);
  return found !== undefined && found.value === (expected === undefined ? true : iniValue(expected)) ? `${key} in ${file}` : undefined;
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
  const lists = new Map<string, { values: string[]; line: number; text: string }>();
  let optional: { value: string; line: number } | undefined;
  for (const entry of iniEntries(text)) {
    const list = entry.key.endsWith('[]');
    const key = list ? entry.key.slice(0, -2) : entry.key;
    if (key === facts.alias.setting) optional = { value: entry.value, line: entry.line };
    if (key !== facts.omit.setting && key !== facts.include.setting) continue;
    const known = lists.get(key);
    lists.set(key, { values: list && known !== undefined ? [...known.values, entry.value] : [entry.value], line: entry.line, text: `${entry.key}=${entry.value}` });
  }
  const omit = lists.get(facts.omit.setting);
  const included = lists.get(facts.include.setting)?.values.includes(facts.omit.value) === true || optional?.value === 'true';
  if (omit?.values.includes(facts.omit.value) === true) return { omitted: !included, included, line: omit.line, entry: omit.text };
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
  // include=optional in .npmrc wins over an omit on the command line, which sets another key.
  if (npmrc.included) return places;
  const omits = (command: ToolCommand) => command.tool === 'npm' && command.kind === 'install' && command.optionalDependencies === 'omitted';
  for (const job of detection.jobs) {
    for (const command of job.commands.filter(omits)) places.push(commandPlace(command, `in job ${job.id} of ${job.file}`, job.file));
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
