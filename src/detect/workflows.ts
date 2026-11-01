// Reads GitHub Actions workflows: versions passed to the setup actions known to the knowledge base (a
// ${{ matrix.<key> }} value stands for each value of that matrix key), and what the run steps of each job do with
// npm and pip (installs, npm install -g npm@<version>).
import { isMap, isScalar, isSeq, LineCounter, type Node, type YAMLMap } from 'yaml';
import { parseYamlDocument } from '../yaml-parse.ts';
import type { RuntimeOrTool, SetupActionKnowledge } from '../knowledge/types.ts';
import { findToolCommands, UNKNOWN_DIRECTORY } from './commands.ts';
import { imageRuntime } from './dockerfiles.ts';
import type { DetectionFacts } from './knowledge.ts';
import { joinPath, type Repository } from './repository.ts';
import type { VersionDeclaration, WorkflowJob } from './types.ts';

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

/** The directory of a command: the working directory of its step joined with the literal cd before it (decision D-115). */
function commandDirectory(step: string | undefined, cd: string | undefined): string | undefined {
  if (cd === undefined) return step;
  if (cd === UNKNOWN_DIRECTORY || step === undefined) return cd;
  return `${step}/${cd}`;
}

/** The variables of an env map whose values are scalars, as text (a YAML true is "true"). */
function environmentOf(node: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (!isMap(node)) return found;
  for (const pair of node.items) {
    const key = scalarText(pair.key);
    const value = scalarText(pair.value);
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

export function readWorkflows(repository: Repository, facts: DetectionFacts): WorkflowFindings {
  const { directory, extensions } = facts.workflows;
  const files = repository
    .listFiles(directory)
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => joinPath(directory, name));
  const findings: WorkflowFindings = { files, versions: [], installs: [], jobs: [] };

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

    const jobs = document.get('jobs');
    if (!isMap(jobs)) continue;
    const workflowDirectory = defaultDirectory(document.contents);
    const { key: envKey } = facts.workflowEnvironment;
    const workflowEnvironment = environmentOf(isMap(document.contents) ? document.contents.get(envKey) : undefined);
    for (const pair of jobs.items) {
      const id = scalarText(pair.key);
      const job = pair.value;
      if (id === undefined || !isMap(job)) continue;
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
      const keyLine = isScalar(pair.key) ? lineOf(pair.key) : undefined;
      const record: WorkflowJob = { file, id, line: keyLine ?? 1, commands: [], runsNode: false };
      findings.jobs.push(record);
      const jobDirectory = defaultDirectory(job) ?? workflowDirectory;
      // The image of jobs.<id>.container runs the steps: its node image declares the Node.js they use (decision D-115).
      const { key: containerKey, imageKey, envKey: containerEnvKey } = facts.jobContainer;
      const container = job.get(containerKey, true);
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
      const jobEnvironment = new Map([...environmentOf(isMap(container) ? container.get(containerEnvKey) : undefined), ...workflowEnvironment, ...environmentOf(job.get(envKey))]);
      const steps = job.get('steps');
      if (!isSeq(steps)) continue;
      for (const step of steps.items) {
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
              if (input.kind === 'version' && input.tool !== undefined) declare(input.tool, { version: value }, node, stepLine);
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
        const run = step.get('run', true);
        if (isScalar(run) && typeof run.value === 'string' && run.range !== undefined && run.range !== null) {
          // Read the source text of the step, so that commands inside block scalars get their own line.
          const start = run.range[0];
          const environment = new Map([...jobEnvironment, ...environmentOf(step.get(envKey))]);
          const found = findToolCommands(text.slice(start, run.range[1]), facts.commands, 0, environment);
          record.runsNode ||= found.runsNode;
          const configVariable = facts.commands.pip.delay?.configVariable;
          if (found.pipConfig === true || (configVariable !== undefined && (environment.get(configVariable) ?? '') !== '')) record.pipConfig = true;
          const stepDirectory = step.has('working-directory') ? workingDirectory(step.get('working-directory', true)) : jobDirectory;
          for (const { offset, cd, ...command } of found.commands) {
            const line = lineCounter.linePos(start + offset).line;
            const directory = commandDirectory(stepDirectory, cd);
            record.commands.push({ ...command, line, ...(directory === undefined ? {} : { directory }) });
            if ((command.tool === 'npm' || command.tool === 'poetry') && command.kind === 'upgrade' && command.version !== undefined) {
              findings.versions.push({ tool: command.tool, declaration: { version: command.version, source: 'github-actions', file, line, job: id } });
            }
          }
        }
      }
    }
  }
  return findings;
}
