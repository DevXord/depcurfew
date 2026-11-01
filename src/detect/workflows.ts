// Reads GitHub Actions workflows: versions passed to the setup actions known to the knowledge base (a
// ${{ matrix.<key> }} value stands for each value of that matrix key), and what the run steps of each job do with
// npm and pip (installs, npm install -g npm@<version>).
import { isMap, isScalar, isSeq, LineCounter, type Node, type YAMLMap } from 'yaml';
import { parseYamlDocument } from '../yaml-parse.ts';
import type { RuntimeOrTool, SetupActionKnowledge } from '../knowledge/types.ts';
import { findToolCommands } from './commands.ts';
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

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

function findAction(actions: readonly SetupActionKnowledge[], uses: string): SetupActionKnowledge | undefined {
  const name = uses.split('@', 1)[0]?.toLowerCase();
  return actions.find((action) => action.action.toLowerCase() === name);
}

/** The values of a matrix key: its list, and the values include entries give it; undefined when they cannot be listed. */
function matrixValues(job: YAMLMap, key: string): Node[] | undefined {
  const strategy = job.get('strategy');
  const matrix = isMap(strategy) ? strategy.get('matrix') : undefined;
  if (!isMap(matrix)) return undefined;
  const values: Node[] = [];
  const list = matrix.get(key, true);
  if (isSeq(list)) {
    for (const item of list.items) {
      if (!isScalar(item)) return undefined;
      values.push(item);
    }
  } else if (list !== undefined) {
    return undefined;
  }
  const include = matrix.get('include');
  if (isSeq(include)) {
    for (const entry of include.items) {
      const value = isMap(entry) ? entry.get(key, true) : undefined;
      if (isScalar(value)) values.push(value);
    }
  }
  return values.length === 0 ? undefined : values;
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
    for (const pair of jobs.items) {
      const id = scalarText(pair.key);
      const job = pair.value;
      if (id === undefined || !isMap(job)) continue;
      const declare = (tool: RuntimeOrTool, value: { version: string } | { versionFile: string }, node: Node, step: number | undefined) => {
        const matrix = 'version' in value ? MATRIX_VALUE.exec(value.version)?.[1] : undefined;
        const expanded = matrix === undefined ? undefined : matrixValues(job, matrix);
        if (matrix !== undefined && expanded !== undefined) {
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
          const found = findToolCommands(text.slice(start, run.range[1]), facts.commands);
          record.runsNode ||= found.runsNode;
          for (const { offset, ...command } of found.commands) {
            const line = lineCounter.linePos(start + offset).line;
            record.commands.push({ ...command, line });
            if (command.tool === 'npm' && command.kind === 'upgrade' && command.version !== undefined) {
              findings.versions.push({ tool: 'npm', declaration: { version: command.version, source: 'github-actions', file, line, job: id } });
            }
          }
        }
      }
    }
  }
  return findings;
}
