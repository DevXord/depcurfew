// Reads GitHub Actions workflows: versions passed to the setup actions known to the knowledge base (a
// ${{ matrix.<key> }} value stands for each value of that matrix key), and what the run steps of each job do with
// npm and pip (installs, npm install -g npm@<version>).
import { isAlias, isMap, isScalar, isSeq, LineCounter, type Document, type Node, type YAMLMap } from 'yaml';
import { MAX_YAML_ALIASES, parseYamlDocument } from '../yaml-parse.ts';
import { environment as knowledge } from '../knowledge/environment.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { RuntimeOrTool, SetupActionKnowledge } from '../knowledge/types.ts';
import { findToolCommands, overLimitMessages, UNKNOWN_DIRECTORY, withVariables } from './commands.ts';
import { imageRuntime } from './dockerfiles.ts';
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

const MATRIX_VALUE = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/u;
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

/**
 * The values of a matrix key: its list and the values include entries give it, each value once (at its first line),
 * without the values an exclude entry with only this key removes (an entry with more keys removes some combinations
 * only, so the value stays). undefined when they cannot be listed, `too-many` past MAX_MATRIX_VALUES.
 */
function matrixValues(job: YAMLMap, key: string): Node[] | 'too-many' | undefined {
  const strategy = job.get('strategy');
  const matrix = isMap(strategy) ? strategy.get('matrix') : undefined;
  if (!isMap(matrix)) return undefined;
  const values = new Map<string, Node>();
  const add = (item: Node): boolean => {
    const text = scalarText(item);
    if (text === undefined || values.has(text)) return true;
    if (values.size >= MAX_MATRIX_VALUES) return false;
    values.set(text, item);
    return true;
  };
  const list = matrix.get(key, true);
  if (isSeq(list)) {
    for (const item of list.items) {
      if (!isScalar(item)) return undefined;
      if (!add(item)) return 'too-many';
    }
  } else if (list !== undefined) {
    return undefined;
  }
  const include = matrix.get('include');
  if (isSeq(include)) {
    for (const entry of include.items) {
      const value = isMap(entry) ? entry.get(key, true) : undefined;
      if (isScalar(value) && !add(value)) return 'too-many';
    }
  }
  const exclude = matrix.get('exclude');
  if (isSeq(exclude) && isSeq(list)) {
    const included = new Set(isSeq(include) ? include.items.map((item) => (isMap(item) ? scalarText(item.get(key, true)) : undefined)) : []);
    for (const entry of exclude.items) {
      if (!isMap(entry) || entry.items.length !== 1) continue;
      const value = entry.get(key, true);
      const text = isScalar(value) ? scalarText(value) : undefined;
      // Only a value of the key's own list is excluded; GitHub adds include entries after exclude.
      if (text !== undefined && !included.has(text)) values.delete(text);
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
    const lineCounter = new LineCounter();
    const document = parseYamlDocument(text, lineCounter);
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
    const { key: envKey } = facts.workflowEnvironment;
    // Only the variables commands read are kept, so thousands of env entries cost no more per step (decision D-121).
    const workflowEnvironment = withVariables(facts.commands, environmentOf(isMap(document.contents) ? document.contents.get(envKey) : undefined, resolve, asWritten));
    for (const pair of jobs.items) {
      const id = scalarText(pair.key);
      const job = resolve(pair.value);
      if (id === undefined || !isMap(job)) continue;
      const keyLine = isScalar(pair.key) ? lineOf(pair.key) : undefined;
      const declare = (tool: RuntimeOrTool, value: { version: string } | { versionFile: string }, node: Node, step: number | undefined) => {
        const matrix = 'version' in value ? MATRIX_VALUE.exec(value.version)?.[1] : undefined;
        const expanded = matrix === undefined ? undefined : matrixValues(job, matrix);
        if (matrix !== undefined && expanded === 'too-many') {
          const line = lineOf(node);
          const unknown = `the matrix lists more than ${MAX_MATRIX_VALUES} values for ${matrix}, which depcurfew does not check`;
          findings.versions.push({ tool, declaration: { ...value, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }), matrix, unknown } });
          return;
        }
        if (matrix !== undefined && Array.isArray(expanded)) {
          for (const item of expanded) {
            const version = scalarText(item);
            const line = lineOf(item);
            if (version !== undefined) findings.versions.push({ tool, declaration: { version, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }), matrix } });
          }
          return;
        }
        const line = lineOf(node);
        findings.versions.push({ tool, declaration: { ...value, source: 'github-actions', file, ...(line === undefined ? {} : { line }), job: id, ...(step === undefined ? {} : { step }) } });
      };
      const record: WorkflowJob = { file, id, line: keyLine ?? 1, commands: [], runsNode: false };
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
        const run = resolve(step.get('run', true));
        if (isScalar(run) && typeof run.value === 'string' && run.range !== undefined && run.range !== null) {
          // Read the source text of the step, so that commands inside block scalars get their own line.
          const start = run.range[0];
          const environment = withVariables(facts.commands, jobEnvironment, environmentOf(step.get(envKey), resolve, asWritten));
          const found = findToolCommands(text.slice(start, run.range[1]), facts.commands, 0, environment);
          const runLine = lineCounter.linePos(start).line;
          for (const message of overLimitMessages(found.overLimit, `the run step of ${jobLabel(id, keyLine)} in ${file} (line ${runLine})`)) repository.warn('script-not-followed', message, [file], runLine);
          record.runsNode ||= found.runsNode;
          const configVariable = facts.commands.pip.delay?.configVariable;
          if (found.pipConfig === true || (configVariable !== undefined && (environment.get(configVariable) ?? '') !== '')) record.pipConfig = true;
          // Commands after a Corepack command of an earlier step or earlier in this one (decision D-141).
          const seenCorepack = record.corepack !== undefined;
          if (found.corepack !== undefined) record.corepack ??= lineCounter.linePos(start + found.corepack).line;
          const stepDirectory = step.has('working-directory') ? workingDirectory(step.get('working-directory', true)) : jobDirectory;
          for (const { offset, cd, ...command } of found.commands) {
            const line = lineCounter.linePos(start + offset).line;
            const directory = commandDirectory(stepDirectory, cd);
            const afterCorepack = seenCorepack || (found.corepack !== undefined && found.corepack < offset);
            record.commands.push({ ...command, line, ...(directory === undefined ? {} : { directory }), ...(afterCorepack ? { afterCorepack: true as const } : {}) });
            // bundle _4.0.12_ install runs that Bundler, so its version counts too (decision D-159).
            if ((command.tool === 'npm' || command.tool === 'poetry' || command.tool === 'bundler') && (command.kind === 'upgrade' || command.tool === 'bundler') && command.version !== undefined) {
              findings.versions.push({ tool: command.tool, declaration: { version: command.version, source: 'github-actions', file, line, job: id } });
            }
          }
        }
      }
    }
  }
  return findings;
}
