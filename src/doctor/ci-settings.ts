// Where the CI workflows and Dockerfiles of a repository set environment variables and which commands they run, with
// the line of each (decision D-166), for the rules that look for settings that turn a protection off there
// (ci-weakens-policy, bundler-config-weakens, composer-config-weakens): the env of the workflow, of each job, of its
// container and of each step; export, NAME=value before a command and NAME=value written to $GITHUB_ENV in the run
// steps; ENV and ARG of every Dockerfile stage and the same in its RUN instructions (shell form, exec form and
// here-documents fed to a shell). Each file is read once per repository; nothing is run.
import { isAlias, isMap, isScalar, isSeq, type Document, type Node } from 'yaml';
import { commandParts, programName, type Word } from '../detect/commands.ts';
import { argDeclarations, lineAt, readDockerfileOnce } from '../detect/dockerfile.ts';
import { envDeclarations, execWords, isScript, withoutOptions } from '../detect/dockerfiles.ts';
import type { Repository } from '../detect/repository.ts';
import { readScript } from '../detect/script-variables.ts';
import type { Detection } from '../detect/types.ts';
import { jobLabel } from '../detect/workflows.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { environment, knowledgeBase } from '../knowledge/index.ts';
import { MAX_YAML_ALIASES, readYamlDocument } from '../yaml-parse.ts';

/**
 * env: an env map of a workflow (workflow, job, container or step); export and command: export NAME=value and
 * NAME=value before one command in a run step; environment-file: NAME=value written to $GITHUB_ENV, which the later
 * steps of the job get; dockerfile-env and dockerfile-arg: ENV and ARG of a Dockerfile stage; run-export and run-command:
 * export and NAME=value before a command in a RUN instruction.
 */
export type CiVariableKind = 'env' | 'export' | 'command' | 'environment-file' | 'dockerfile-env' | 'dockerfile-arg' | 'run-export' | 'run-command';

export interface CiVariable {
  name: string;
  value: string;
  kind: CiVariableKind;
  file: string;
  line?: number;
  /** The place as messages name it: "the workflow", "job build", "step 2 of job build", "the stage at line 1". */
  where: string;
  /** command and run-command: the program the variable is set for, as written. */
  program?: string;
}

export interface CiCommand {
  /** The program and its arguments, after the assignments and wrappers (sudo, env) before them. */
  words: string[];
  file: string;
  line: number;
  /** "job build" or "the stage at line 1", as messages name it. */
  where: string;
  /** A Dockerfile RUN instruction rather than a run step of a workflow. */
  dockerfile: boolean;
}

export interface CiSettings {
  variables: CiVariable[];
  commands: CiCommand[];
}

const ENV_KEY = evidenceOf(environment.githubActions.environmentKeys)[0]?.value.key ?? 'env';
const CONTAINER = evidenceOf(environment.githubActions.jobContainer)[0]?.value ?? { key: 'container', imageKey: 'image', envKey: 'env' };
const ENVIRONMENT_FILE = evidenceOf(environment.githubActions.environmentFile)[0]?.value.variable ?? 'GITHUB_ENV';
const EXPANDS_ALIASES = evidenceOf(environment.githubActions.yamlAliases)[0]?.value.accepted === true;
const SYNTAX = evidenceOf(environment.docker.syntax)[0]?.value;
const DOCKER_ENV = evidenceOf(environment.docker.environment)[0]?.value;
const BUILD_ARGUMENTS = evidenceOf(environment.docker.buildArguments)[0]?.value;

const READ = new WeakMap<Repository, CiSettings>();

/** An extra fact of a tool as its value, or undefined. */
function extraValue(key: string): unknown[] {
  return knowledgeBase.flatMap((tool) => (tool.extra?.[key] === undefined ? [] : evidenceOf(tool.extra[key]).map((entry) => entry.value as unknown)));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The variables the rules look at, in lower case (a superset of each tool's spellings): those of installOverrides,
 * Composer's environmentOverrides, Bundler's cooldownSetting and npm's settingOverrides. Others are not kept, so that a
 * workflow or a Dockerfile with thousands of other variables costs little (decision D-121).
 */
const WATCHED_VARIABLES: ReadonlySet<string> = new Set(
  [
    ...extraValue('installOverrides').flatMap((value) => (isObject(value) ? listOf(value['variables']) : [])),
    ...extraValue('environmentOverrides').flatMap(listOf),
  ]
    .flatMap((entry) => (isObject(entry) && typeof entry['name'] === 'string' ? [entry['name']] : []))
    .concat(extraValue('cooldownSetting').flatMap((value) => (isObject(value) && typeof value['variable'] === 'string' ? [value['variable']] : [])))
    .concat(
      extraValue('settingOverrides').flatMap((value) =>
        isObject(value) && typeof value['variablePrefix'] === 'string'
          ? listOf(value['settings']).flatMap((entry) => (isObject(entry) && typeof entry['setting'] === 'string' ? [`${String(value['variablePrefix'])}${entry['setting'].replaceAll('-', '_')}`] : []))
          : [],
      ),
    )
    .map((name) => name.toLowerCase()),
);

/** The programs the rules look at: those of each tool's commandLine, Bundler's executables and composer. */
const WATCHED_PROGRAMS: ReadonlySet<string> = new Set([
  ...extraValue('commandLine').flatMap((value) =>
    isObject(value) ? [...listOf(value['add']), ...listOf(value['run']).map((entry) => (isObject(entry) ? entry['command'] : undefined))].flatMap((command) => (Array.isArray(command) && typeof command[0] === 'string' ? [command[0]] : [])) : [],
  ),
  ...extraValue('resolveCommands').flatMap((value) => (isObject(value) ? listOf(value['executables']).filter((item): item is string => typeof item === 'string') : [])),
]);

const watchedVariable = (name: string) => WATCHED_VARIABLES.has(name.toLowerCase());
const watchedProgram = (word: string | undefined) => word !== undefined && WATCHED_PROGRAMS.has(programName(word));

/** The settings of the workflows and Dockerfiles detection found, read once per repository. */
export function ciSettings(repository: Repository, detection: Detection): CiSettings {
  let found = READ.get(repository);
  if (found === undefined) {
    found = { variables: [], commands: [] };
    for (const file of detection.workflows) readWorkflow(repository, file, found);
    for (const dockerfile of detection.dockerfiles) readDockerfileSettings(repository, dockerfile.file, found);
    READ.set(repository, found);
  }
  return found;
}

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

/** Reads an alias as the node of its anchor, as GitHub does (decision D-141), at most MAX_YAML_ALIASES of them in a file. */
function resolver(document: Document.Parsed): (node: unknown) => unknown {
  let left = MAX_YAML_ALIASES;
  return (node) => {
    if (!isAlias(node)) return node;
    if (!EXPANDS_ALIASES || left <= 0) return undefined;
    left -= 1;
    return node.resolve(document);
  };
}

function readWorkflow(repository: Repository, file: string, found: CiSettings): void {
  const text = repository.readText(file);
  if (text === undefined) return;
  const { document, lineCounter } = readYamlDocument(text);
  if (document.errors.length > 0) return;
  const resolve = resolver(document);
  const lineOf = (node: Node | null | undefined): number | undefined =>
    node === null || node === undefined || node.range === undefined || node.range === null ? undefined : lineCounter.linePos(node.range[0]).line;
  const envMap = (node: unknown, where: string) => {
    const map = resolve(node);
    if (!isMap(map)) return;
    for (const pair of map.items) {
      const name = scalarText(pair.key);
      const value = scalarText(resolve(pair.value));
      if (name === undefined || value === undefined || !watchedVariable(name)) continue;
      const line = lineOf(pair.key as Node);
      found.variables.push({ name, value, kind: 'env', file, ...(line === undefined ? {} : { line }), where });
    }
  };
  const root = document.contents;
  if (!isMap(root)) return;
  envMap(root.get(ENV_KEY, true), 'the workflow');
  const jobs = resolve(root.get('jobs', true));
  if (!isMap(jobs)) return;
  for (const pair of jobs.items) {
    const id = scalarText(pair.key);
    const job = resolve(pair.value);
    if (id === undefined || !isMap(job)) continue;
    const label = jobLabel(id, lineOf(pair.key as Node));
    envMap(job.get(ENV_KEY, true), label);
    const container = resolve(job.get(CONTAINER.key, true));
    if (isMap(container)) envMap(container.get(CONTAINER.envKey, true), `the container of ${label}`);
    const steps = resolve(job.get('steps', true));
    if (!isSeq(steps)) continue;
    steps.items.forEach((item, index) => {
      const step = resolve(item);
      if (!isMap(step)) return;
      envMap(step.get(ENV_KEY, true), `step ${index + 1} of ${label}`);
      const run = resolve(step.get('run', true));
      if (!isScalar(run) || typeof run.value !== 'string' || run.range === undefined || run.range === null) return;
      const start = run.range[0];
      const script = readScript(text.slice(start, run.range[1]), ENVIRONMENT_FILE);
      const at = (offset: number) => lineCounter.linePos(start + offset).line;
      for (const variable of script.variables) {
        if (!watchedVariable(variable.name)) continue;
        const kind = variable.how === 'environment-file' ? 'environment-file' : variable.how === 'export' ? 'export' : 'command';
        const program = kind === 'command' ? variable.program : undefined;
        found.variables.push({ name: variable.name, value: variable.value, kind, file, line: at(variable.offset), where: label, ...(program === undefined ? {} : { program }) });
      }
      for (const command of script.commands) if (watchedProgram(command.words[0]?.text)) found.commands.push({ words: command.words.map((word) => word.text), file, line: at(command.offset), where: label, dockerfile: false });
    });
  }
}

/** A stage as messages name it, as bundler-config-weakens does: "stage build", or "the stage at line 1". */
function stageName(name: string | undefined, line: number): string {
  return name === undefined ? `the stage at line ${line}` : `stage ${name}`;
}

function readDockerfileSettings(repository: Repository, file: string, found: CiSettings): void {
  if (SYNTAX === undefined || DOCKER_ENV === undefined) return;
  const text = repository.readText(file);
  if (text === undefined) return;
  const global = new Map<string, string | undefined>();
  let stage: string | undefined;
  const fromScript = (script: string, line: (offset: number) => number, where: string) => {
    const reading = readScript(script);
    for (const variable of reading.variables) {
      if (!watchedVariable(variable.name)) continue;
      const kind = variable.how === 'export' ? 'run-export' : 'run-command';
      const program = kind === 'run-command' ? variable.program : undefined;
      found.variables.push({ name: variable.name, value: variable.value, kind, file, line: line(variable.offset), where, ...(program === undefined ? {} : { program }) });
    }
    for (const command of reading.commands) if (watchedProgram(command.words[0]?.text)) found.commands.push({ words: command.words.map((word) => word.text), file, line: line(command.offset), where, dockerfile: true });
  };
  for (const instruction of readDockerfileOnce(text, SYNTAX)) {
    if (instruction.keyword === 'FROM') {
      const words = instruction.text.split(/\s+/u).filter(Boolean);
      const position = words.findIndex((word) => !word.startsWith('--'));
      const alias = words[position + 1]?.toLowerCase() === 'as' ? words[position + 2]?.toLowerCase() : undefined;
      stage = stageName(alias, instruction.line);
      continue;
    }
    if (instruction.keyword === SYNTAX.globalArgInstruction && stage === undefined) {
      for (const [name, value] of argDeclarations(instruction.text)) global.set(name, value);
      continue;
    }
    if (stage === undefined) continue;
    if (instruction.keyword === DOCKER_ENV.instruction) {
      for (const [name, value] of envDeclarations(instruction.text, DOCKER_ENV.spaceForm)) if (watchedVariable(name)) found.variables.push({ name, value, kind: 'dockerfile-env', file, line: instruction.line, where: stage });
      continue;
    }
    if (BUILD_ARGUMENTS !== undefined && BUILD_ARGUMENTS.runEnvironment && instruction.keyword === BUILD_ARGUMENTS.instruction) {
      for (const [name, value] of argDeclarations(instruction.text)) {
        // An ARG without a value takes the default of an ARG before the first FROM.
        const given = value ?? (BUILD_ARGUMENTS.globalNeedsDeclaration ? global.get(name) : undefined);
        if (given !== undefined && watchedVariable(name)) found.variables.push({ name, value: given, kind: 'dockerfile-arg', file, line: instruction.line, where: stage });
      }
      continue;
    }
    if (instruction.keyword !== 'RUN') continue;
    const where = stage;
    const { text: body, offset } = withoutOptions(instruction.text);
    const exec = execWords(body);
    if (exec !== undefined) {
      const { command, assignments } = commandParts(exec.map((word): Word => ({ text: word, offset: 0 })));
      for (const [name, value] of assignments) if (watchedVariable(name)) found.variables.push({ name, value, kind: 'run-command', file, line: instruction.line, where, ...(command[0] === undefined ? {} : { program: command[0].text }) });
      if (watchedProgram(command[0]?.text)) found.commands.push({ words: command.map((word) => word.text), file, line: instruction.line, where, dockerfile: true });
      continue;
    }
    fromScript(body, (at) => lineAt(instruction, offset + at), where);
    for (const heredoc of instruction.heredocs) {
      if (!isScript(heredoc.command)) continue;
      const starts = [0];
      for (let index = heredoc.body.indexOf('\n'); index >= 0; index = heredoc.body.indexOf('\n', index + 1)) starts.push(index + 1);
      fromScript(heredoc.body, (at) => heredoc.line + lastAtOrBefore(starts, at), where);
    }
  }
}

/** The index of the last start at or before an offset, by binary search. */
function lastAtOrBefore(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Where a variable is set and what it reaches, for the message of a rule ("X=0 is set in the env of job build in
 * ci.yml, reaches every npm command there, and ..."), and how to remove it, by the kind of place.
 */
export function variablePlace(variable: CiVariable, tool: string): { place: string; reach: string; remove: string } {
  const { file, where, name } = variable;
  const name_ = tool;
  switch (variable.kind) {
    case 'env':
      return { place: `is set in the env of ${where} in ${file}`, reach: `reaches every ${name_} command there`, remove: `Remove ${name} from that env in ${file}` };
    case 'export':
      return { place: `is exported in a run step of ${where} in ${file}`, reach: `reaches the ${name_} commands after it in that step`, remove: `Remove that export of ${name} from ${file}` };
    case 'command':
      return { place: `is set for ${variable.program ?? 'a command'} in a run step of ${where} in ${file}`, reach: `reaches the ${name_} commands it runs`, remove: `Remove ${name} from that command in ${file}` };
    case 'environment-file':
      return { place: `is written to $GITHUB_ENV in a run step of ${where} in ${file}`, reach: `reaches every ${name_} command of the later steps of the job`, remove: `Remove the line that writes ${name} to $GITHUB_ENV in ${file}` };
    case 'dockerfile-env':
      return { place: `is set with ENV in ${where} of ${file}`, reach: `reaches every ${name_} command of the later RUN instructions there and of the stages built from it`, remove: `Remove ${name} from that ENV instruction in ${file}` };
    case 'dockerfile-arg':
      return {
        place: `is the default of an ARG instruction in ${where} of ${file}`,
        reach: `reaches every ${name_} command of the later RUN instructions there, which get build arguments as variables`,
        remove: `Remove the default of ${name} from that ARG instruction in ${file} (or the ARG)`,
      };
    case 'run-export':
      return { place: `is exported in a RUN instruction of ${where} in ${file}`, reach: `reaches the ${name_} commands after it in that instruction`, remove: `Remove that export of ${name} from ${file}` };
    case 'run-command':
      return { place: `is set for ${variable.program ?? 'a command'} in a RUN instruction of ${where} in ${file}`, reach: `reaches the ${name_} commands it runs`, remove: `Remove ${name} from that command in ${file}` };
  }
}
