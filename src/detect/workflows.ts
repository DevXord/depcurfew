// Reads GitHub Actions workflows: versions passed to the setup actions known to the knowledge base (a
// ${{ matrix.<key> }} value stands for each value of that matrix key), and what the run steps of each job do with
// npm and pip (installs, npm install -g npm@<version>).
import { isAlias, isMap, isScalar, isSeq, type Document, type Node, type YAMLMap } from 'yaml';
import { MAX_YAML_ALIASES, readYamlDocument } from '../yaml-parse.ts';
import { environment as knowledge } from '../knowledge/environment.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { RuntimeOrTool, SetupActionKnowledge } from '../knowledge/types.ts';
import { findToolCommands, overLimitMessages, pipVersion, UNKNOWN_DIRECTORY, withVariables } from './commands.ts';
import { substitute } from './dockerfile.ts';
import { requestIn } from './mise.ts';
import { parseToml } from './toml.ts';
import { imageRuntime } from './dockerfiles.ts';
import { readScript } from './script-variables.ts';
import type { DetectionFacts } from './knowledge.ts';
import { joinPath, type Repository } from './repository.ts';
import type { ToolCommand, VersionDeclaration, WorkflowJob } from './types.ts';

export interface WorkflowFindings {
  files: string[];
  /** Versions per tool, in file and line order. */
  versions: { tool: RuntimeOrTool; declaration: VersionDeclaration }[];
  /** Tools a setup step installs, with the workflow that shows it. */
  installs: { tool: RuntimeOrTool; file: string }[];
  jobs: WorkflowJob[];
}

/**
 * One ${{ matrix.<key> }} or ${{ matrix.<key>.<property> }} in a value, with text around it (${{ matrix.node }}.x,
 * decision D-173): the path of the value and the text before and after it.
 */
const MATRIX_VALUE = /^([^$]*)\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\s*\}\}([^$]*)$/u;
/** At most this many values of one matrix key are checked; a longer list is reported as not checked (a notice). */
export const MAX_MATRIX_VALUES = 256;

/** The ids GitHub accepts as keys of jobs (environment.githubActions.jobId). */
const JOB_ID = new RegExp(evidenceOf(knowledge.githubActions.jobId)[0]?.value.pattern ?? '^[A-Za-z_][A-Za-z0-9_-]*$', 'u');

/**
 * A job as messages and fixes name it (decision D-135): "job build" when its key is an id GitHub accepts, else "the job
 * at line 12" (or "a job"). GitHub runs no job with another key, and the text of the key could be anything, such as an
 * instruction, which a fix must not repeat.
 */
export function jobLabel(id: string | undefined, line: number | undefined): string {
  if (id !== undefined && JOB_ID.test(id)) return `job ${id}`;
  return line === undefined ? 'a job' : `the job at line ${line}`;
}

/** jobLabel for the job of a github-actions declaration, with the line of its key from the jobs of the detection. */
export function declarationJob(declaration: VersionDeclaration, jobs: readonly WorkflowJob[]): string {
  const job = jobs.find((entry) => entry.file === declaration.file && entry.id === declaration.job);
  return jobLabel(declaration.job, job?.line);
}

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

function findAction(actions: readonly SetupActionKnowledge[], uses: string): SetupActionKnowledge | undefined {
  const name = uses.split('@', 1)[0]?.toLowerCase();
  return actions.find((action) => action.action.toLowerCase() === name);
}

/** The scalar of a matrix value at the properties after its key (matrix.cfg.node: node of each object of cfg). */
function valueAt(node: unknown, properties: readonly string[]): Node | undefined {
  let current = node;
  for (const property of properties) {
    if (!isMap(current)) return undefined;
    current = current.get(property, true);
  }
  return isScalar(current) ? current : undefined;
}

/**
 * The values of a matrix key, or of a property of its objects (cfg.node, decision D-173): its list and the values
 * include entries give it, each value once (at its first line), without the values an exclude entry with only this key
 * removes (an entry with more keys removes some combinations only, so the value stays; an object is removed only by an
 * exclude entry equal to it). undefined when they cannot be listed, `too-many` past MAX_MATRIX_VALUES.
 */
function matrixValues(job: YAMLMap, path: string): Node[] | 'too-many' | undefined {
  const [key = '', ...properties] = path.split('.');
  const strategy = job.get('strategy');
  const matrix = isMap(strategy) ? strategy.get('matrix') : undefined;
  if (!isMap(matrix)) return undefined;
  const values = new Map<string, Node>();
  const add = (item: Node | undefined): boolean => {
    const text = scalarText(item);
    if (item === undefined || text === undefined || values.has(text)) return true;
    if (values.size >= MAX_MATRIX_VALUES) return false;
    values.set(text, item);
    return true;
  };
  const list = matrix.get(key, true);
  // The items of the key's list that an exclude entry removes; GitHub adds include entries after exclude.
  const excluded = new Set<unknown>();
  const exclude = matrix.get('exclude');
  const include = matrix.get('include');
  if (isSeq(list) && isSeq(exclude)) {
    const same = (a: unknown, b: unknown) => JSON.stringify(isScalar(a) || isMap(a) || isSeq(a) ? a.toJSON() : a) === JSON.stringify(isScalar(b) || isMap(b) || isSeq(b) ? b.toJSON() : b);
    const included = new Set(isSeq(include) ? include.items.map((item) => (isMap(item) ? scalarText(valueAt(item.get(key, true), properties)) : undefined)) : []);
    for (const entry of exclude.items) {
      if (!isMap(entry) || entry.items.length !== 1) continue;
      const value = entry.get(key, true);
      for (const item of list.items) {
        if (!same(item, value)) continue;
        // Only a value of the key's own list is excluded, not one an include entry gives again.
        if (properties.length === 0 && included.has(scalarText(item))) continue;
        excluded.add(item);
      }
    }
  }
  if (isSeq(list)) {
    for (const item of list.items) {
      if (properties.length === 0 ? !isScalar(item) : !isMap(item)) return undefined;
      if (excluded.has(item)) continue;
      if (!add(valueAt(item, properties))) return 'too-many';
    }
  } else if (list !== undefined) {
    return undefined;
  }
  if (isSeq(include)) {
    for (const entry of include.items) {
      const value = isMap(entry) ? valueAt(entry.get(key, true), properties) : undefined;
      if (value !== undefined && !add(value)) return 'too-many';
    }
  }
  return values.size === 0 ? undefined : [...values.values()];
}

/** A working directory as written, without ./ and a trailing /; undefined for the root. */
function workingDirectory(node: unknown): string | undefined {
  const text = scalarText(node)?.trim();
  if (text === undefined) return undefined;
  let value = text.replace(/\\/gu, '/');
  while (value.startsWith('./')) value = value.slice(2);
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value === '' || value === '.' ? undefined : value;
}

/** The project (a directory listed in projects) a command's working directory lies in; '' for the root and any other directory. */
export function projectOf(command: Pick<ToolCommand, 'directory'>, projects: readonly string[]): string {
  const directory = command.directory;
  if (directory === undefined) return '';
  return projects.find((project) => directory === project || directory.startsWith(`${project}/`)) ?? '';
}

/** The directory of a command: the working directory of its step joined with the literal cd before it (decision D-115). */
function commandDirectory(step: string | undefined, cd: string | undefined): string | undefined {
  if (cd === undefined) return step;
  if (cd === UNKNOWN_DIRECTORY || step === undefined) return cd;
  return `${step}/${cd}`;
}

/**
 * The variables of an env map whose values are scalars, as text (a YAML true is "true"). `resolve` reads an alias
 * (*name) as the node of its anchor, as GitHub expands aliases in workflows (decision D-141). The variables of
 * `asWritten` take a plain scalar as written (BUNDLE_COOLDOWN: 1e400 is "1e400", which Bundler reads with to_i as 1;
 * decision D-159).
 */
function environmentOf(node: unknown, resolve: (node: unknown) => unknown = (item) => item, asWritten: ReadonlySet<string> = new Set()): Map<string, string> {
  const found = new Map<string, string>();
  const map = resolve(node);
  if (!isMap(map)) return found;
  for (const pair of map.items) {
    const key = scalarText(pair.key);
    const item = resolve(pair.value);
    const written = key !== undefined && asWritten.has(key) && isScalar(item) && item.type === 'PLAIN' && typeof item.source === 'string' ? item.source : undefined;
    const value = written ?? scalarText(item);
    if (key !== undefined && value !== undefined) found.set(key, value);
  }
  return found;
}

/** defaults.run.working-directory of a workflow or a job. */
function defaultDirectory(node: unknown): string | undefined {
  const defaults = isMap(node) ? node.get('defaults') : undefined;
  const run = isMap(defaults) ? defaults.get('run') : undefined;
  return isMap(run) ? workingDirectory(run.get('working-directory', true)) : undefined;
}

/** Whether GitHub expands YAML aliases in workflows (environment.githubActions.yamlAliases, decision D-141). */
const EXPANDS_ALIASES = evidenceOf(knowledge.githubActions.yamlAliases)[0]?.value.accepted === true;

/**
 * Reads an alias (*name) as the node of its anchor, as GitHub expands aliases in workflows (decision D-141): at most
 * MAX_YAML_ALIASES of them in a file, after which the others are not followed and a notice says so.
 */
function aliasResolver(document: Document.Parsed, file: string, repository: Repository, lineOf: (node: Node) => number | undefined): (node: unknown) => unknown {
  let left = MAX_YAML_ALIASES;
  return (node) => {
    if (!EXPANDS_ALIASES || !isAlias(node)) return node;
    if (left <= 0) {
      if (left === 0) {
        const line = lineOf(node);
        repository.warn('script-not-followed', `${file} uses more than ${MAX_YAML_ALIASES} YAML aliases; depcurfew follows the first ${MAX_YAML_ALIASES}, so it does not see what the others bring into its jobs, steps and env`, [file], ...(line === undefined ? [] : [line]));
      }
      left -= 1;
      return undefined;
    }
    left -= 1;
    return node.resolve(document);
  };
}

export function readWorkflows(repository: Repository, facts: DetectionFacts): WorkflowFindings {
  const { directory, extensions } = facts.workflows;
  const files = repository
    .listFiles(directory, (name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => joinPath(directory, name));
  const findings: WorkflowFindings = { files, versions: [], installs: [], jobs: [] };
  // Bundler reads BUNDLE_COOLDOWN with to_i, so its value is taken as written (decision D-159).
  const asWritten = new Set(facts.commands.bundler === undefined ? [] : [facts.commands.bundler.variable]);

  for (const file of files) {
    const text = repository.readText(file);
    if (text === undefined) continue;
    // Read through the shared cache, so that the rules that read the workflow again do not parse it again (decision D-166).
    const { document, lineCounter } = readYamlDocument(text);
    if (document.errors.length > 0) {
      const message = document.errors[0]?.message.split('\n', 1)[0] ?? 'invalid YAML';
      repository.warn('invalid-file', `cannot parse ${file}: ${message}`, [file]);
      continue;
    }
    const lineOf = (node: Node) => (node.range === undefined || node.range === null ? undefined : lineCounter.linePos(node.range[0]).line);

    const resolve = aliasResolver(document, file, repository, lineOf);
    const jobs = resolve(document.get('jobs'));
    if (!isMap(jobs)) continue;
    const workflowDirectory = defaultDirectory(document.contents);
    // The env of the workflow as written, for versions written with a variable (decision D-173); read once per file.
    let workflowValues: Map<string, string> | undefined;
    const workflowLookup = () => {
      workflowValues ??= environmentOf(isMap(document.contents) ? document.contents.get(facts.workflowEnvironment.key) : undefined, resolve);
      return workflowValues;
    };
    const { key: envKey } = facts.workflowEnvironment;
    // Only the variables commands read are kept, so thousands of env entries cost no more per step (decision D-121).
    const workflowEnvironment = withVariables(facts.commands, environmentOf(isMap(document.contents) ? document.contents.get(envKey) : undefined, resolve, asWritten));
    for (const pair of jobs.items) {
      const id = scalarText(pair.key);
      const job = resolve(pair.value);
      if (id === undefined || !isMap(job)) continue;
      const keyLine = isScalar(pair.key) ? lineOf(pair.key) : undefined;
      const declare = (tool: RuntimeOrTool, value: { version: string } | { versionFile: string }, node: Node, step: number | undefined) => {
        const parts = 'version' in value ? MATRIX_VALUE.exec(value.version) : null;
        const matrix = parts?.[2];
        const expanded = matrix === undefined ? undefined : matrixValues(job, matrix);
        if (matrix !== undefined && expanded === 'too-many') {
          const line = lineOf(node);
          const unknown = `the matrix lists more than ${MAX_MATRIX_VALUES} values for ${matrix}, which depcurfew does not check`;
          findings.versions.push({ tool, declaration: { ...value, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }), matrix, unknown } });
          return;
        }
        if (matrix !== undefined && Array.isArray(expanded)) {
          for (const item of expanded) {
            const text = scalarText(item);
            const version = text === undefined ? undefined : `${parts?.[1] ?? ''}${text}${parts?.[3] ?? ''}`;
            const line = lineOf(item);
            if (version !== undefined) findings.versions.push({ tool, declaration: { version, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }), matrix } });
          }
          return;
        }
        const line = lineOf(node);
        findings.versions.push({ tool, declaration: { ...value, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }) } });
      };
      const record: WorkflowJob = { file, id, line: keyLine ?? 1, commands: [], runsNode: false };
      // The env of the job and its container as written, for a version written with a variable in a run step (pip
      // install "poetry==${POETRY_VERSION}", decision D-173); read once, and only for such a version.
      let jobValues: { job: Map<string, string>; container: Map<string, string> } | undefined;
      const jobLookup = () => {
        jobValues ??= { job: environmentOf(job.get(envKey), resolve), container: environmentOf(isMap(container) ? container.get(containerEnvKey) : undefined, resolve) };
        return jobValues;
      };
      findings.jobs.push(record);
      const jobDirectory = defaultDirectory(job) ?? workflowDirectory;
      // The image of jobs.<id>.container runs the steps: its node image declares the Node.js they use (decision D-115).
      const { key: containerKey, imageKey, envKey: containerEnvKey } = facts.jobContainer;
      const container = resolve(job.get(containerKey, true));
      const imageNode = isMap(container) ? container.get(imageKey, true) : container;
      const image = scalarText(imageNode);
      if (image !== undefined && isScalar(imageNode) && !image.includes('${{')) {
        const runtime = imageRuntime(image.trim(), facts.docker);
        const line = lineOf(imageNode);
        if (runtime?.tool === 'node') {
          const at = line === undefined ? {} : { line, step: line };
          findings.versions.push({
            tool: 'node',
            declaration: { version: runtime.version ?? runtime.tag ?? image, source: 'github-actions', file, ...at, job: id, container: image.trim(), ...(runtime.version === undefined ? { unknown: runtime.unknown ?? 'the tag names no version' } : {}) },
          });
        }
      }
      // The container's env, then the workflow's and the job's, which docker exec passes over it, then each step's.
      const jobEnvironment = withVariables(facts.commands, environmentOf(isMap(container) ? container.get(containerEnvKey) : undefined, resolve, asWritten), workflowEnvironment, environmentOf(job.get(envKey), resolve, asWritten));
      /**
       * jdx/mise-action (decision D-173): the Node.js and Python of the mise configuration of its working directory, which
       * detection reads from the files there (reader mise, versionFile the directory), or of its mise_toml input; none
       * with install: false.
       */
      const declareMise = (step: YAMLMap, stepLine: number | undefined) => {
        const known = facts.miseAction;
        const inputs = step.get('with');
        const input = (name: string) => (isMap(inputs) ? inputs.get(name, true) : undefined);
        if (scalarText(input(known.inputs.install))?.trim().toLowerCase() === 'false') return;
        const at = { source: 'github-actions' as const, file, ...(stepLine === undefined ? {} : { line: stepLine, step: stepLine }), job: id, reader: 'mise' as const };
        const inline = input(known.inputs.inlineConfig);
        const text = scalarText(inline);
        if (text !== undefined) {
          let document: ReturnType<typeof parseToml> | undefined;
          try {
            document = parseToml(text);
          } catch {
            document = undefined;
          }
          for (const [name, tool] of Object.entries(facts.mise.tools)) {
            const found = document === undefined ? undefined : requestIn(document, facts.mise, name);
            const line = isScalar(inline) ? lineOf(inline) : undefined;
            if (found !== undefined) findings.versions.push({ tool, declaration: { version: found.request, versionFile: `the ${known.inputs.inlineConfig} input`, ...at, ...(line === undefined ? {} : { line }) } });
          }
          return;
        }
        const directory = workingDirectory(input(known.inputs.workingDirectory)) ?? '';
        for (const tool of new Set(Object.values(facts.mise.tools))) findings.versions.push({ tool, declaration: { versionFile: directory, ...at } });
      };
      // NAME=value lines a run step writes to $GITHUB_ENV, for the later steps: over the env of the workflow and the job,
      // under the env of a step (environment.githubActions.environmentFile, decision D-166).
      let written: Map<string, string> = new Map();
      // The working directories of the run steps, kept on the job when one is not the root (decision D-173).
      const runDirectories: string[] = [];
      const steps = resolve(job.get('steps'));
      if (!isSeq(steps)) continue;
      for (const item of steps.items) {
        const step = resolve(item);
        if (!isMap(step)) continue;
        const uses = scalarText(step.get('uses', true));
        const action = uses === undefined ? undefined : findAction(facts.setupActions, uses);
        if (action !== undefined) {
          const stepLine = lineOf(step);
          for (const tool of action.installs) findings.installs.push({ tool, file });
          const inputs = step.get('with');
          if (isMap(inputs)) {
            for (const input of action.inputs) {
              const node = inputs.get(input.name, true);
              const value = scalarText(node);
              if (value === undefined || !isScalar(node)) continue;
              // A keyword such as Gemfile.lock chooses the version some other way (ruby/setup-ruby, decision D-152).
              if (input.kind === 'version' && input.tool !== undefined && input.keywords?.includes(value) !== true) declare(input.tool, { version: value }, node, stepLine);
              if (input.kind === 'version-file' && input.tool !== undefined) declare(input.tool, { versionFile: value }, node, stepLine);
              if (input.kind === 'runtime') {
                const [name, version] = value.split('@');
                if ((name === 'node' || name === 'bun' || name === 'deno') && version !== undefined && version !== '') {
                  declare(name, { version }, node, stepLine);
                }
              }
            }
          }
        }
        if (uses !== undefined && uses.split('@', 1)[0]?.toLowerCase() === facts.miseAction.action.toLowerCase()) declareMise(step, lineOf(step));
        const run = resolve(step.get('run', true));
        if (isScalar(run) && typeof run.value === 'string' && run.range !== undefined && run.range !== null) {
          // Read the source text of the step, so that commands inside block scalars get their own line.
          const start = run.range[0];
          const environment = withVariables(facts.commands, jobEnvironment, written, environmentOf(step.get(envKey), resolve, asWritten));
          const script = text.slice(start, run.range[1]);
          const found = findToolCommands(script, facts.commands, 0, environment);
          if (script.includes(facts.environmentFile)) {
            const writes = readScript(script, facts.environmentFile).variables.filter((variable) => variable.how === 'environment-file');
            if (writes.length > 0) written = withVariables(facts.commands, written, writes.map((variable) => [variable.name, variable.value] as const));
          }
          const runLine = lineCounter.linePos(start).line;
          for (const message of overLimitMessages(found.overLimit, `the run step of ${jobLabel(id, keyLine)} in ${file} (line ${runLine})`)) repository.warn('script-not-followed', message, [file], runLine);
          record.runsNode ||= found.runsNode;
          const configVariable = facts.commands.pip.delay?.configVariable;
          const configFile = configVariable === undefined ? undefined : environment.get(configVariable);
          if (found.pipConfig === true || (configFile ?? '') !== '') record.pipConfig = true;
          // The file it names, for python-config-ignored (decision D-173).
          if (configFile !== undefined && configFile !== '' && !(record.pipConfigFiles ?? []).includes(configFile) && (record.pipConfigFiles?.length ?? 0) < 16) record.pipConfigFiles = [...(record.pipConfigFiles ?? []), configFile];
          // Commands after a Corepack command of an earlier step or earlier in this one (decision D-141).
          const seenCorepack = record.corepack !== undefined;
          if (found.corepack !== undefined) record.corepack ??= lineCounter.linePos(start + found.corepack).line;
          const stepDirectory = step.has('working-directory') ? workingDirectory(step.get('working-directory', true)) : jobDirectory;
          if (!runDirectories.includes(stepDirectory ?? '') && runDirectories.length < 64) runDirectories.push(stepDirectory ?? '');
          let stepValues: Map<string, string> | undefined;
          // The step's env over the job's, the workflow's and the container's, as GitHub passes them.
          const lookup = {
            get: (name: string): string | undefined => {
              stepValues ??= environmentOf(stepEnvironment, resolve);
              const { job: own, container: image } = jobLookup();
              return stepValues.get(name) ?? own.get(name) ?? workflowLookup().get(name) ?? image.get(name);
            },
          };
          const stepEnvironment = step.get(envKey);
          for (const { offset, cd, ...written } of found.commands) {
            let command = written;
            // A version written with a variable of the env (decision D-173), as the shell expands it.
            if (command.version?.includes('$') === true) {
              const result = substitute(command.version, lookup, '\\');
              if (result.ok) command = { ...command, version: command.tool === 'npm' || command.tool === 'bundler' ? result.value.trim() : pipVersion(result.value) };
            }
            const line = lineCounter.linePos(start + offset).line;
            const directory = commandDirectory(stepDirectory, cd);
            const afterCorepack = seenCorepack || (found.corepack !== undefined && found.corepack < offset);
            record.commands.push({ ...command, line, ...(directory === undefined ? {} : { directory }), ...(afterCorepack ? { afterCorepack: true as const } : {}) });
            // bundle _4.0.12_ install runs that Bundler, so its version counts too (decision D-159).
            if (command.tool !== 'pip' && command.tool !== 'pnpm' && command.tool !== 'yarn' && command.tool !== 'bun' && (command.kind === 'upgrade' || command.tool === 'bundler') && command.version !== undefined) {
              findings.versions.push({ tool: command.tool, declaration: { version: command.version, source: 'github-actions', file, line, job: id } });
            }
          }
        }
      }
      if (runDirectories.some((directory) => directory !== '')) record.directories = runDirectories;
    }
  }
  return findings;
}
