// Reads GitHub Actions workflows: versions passed to the setup actions known to the knowledge base, and global
// npm upgrades in run steps (`npm install -g npm@<version>`).
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import type { RuntimeOrTool, SetupActionKnowledge } from '../knowledge/types.ts';
import type { DetectionFacts } from './knowledge.ts';
import { joinPath, type Repository } from './repository.ts';
import type { VersionDeclaration } from './types.ts';

export interface WorkflowFindings {
  files: string[];
  /** Versions per tool, in file and line order. */
  versions: { tool: RuntimeOrTool; declaration: VersionDeclaration }[];
  /** Tools a setup step installs, with the workflow that shows it. */
  installs: { tool: RuntimeOrTool; file: string }[];
}

const NPM_GLOBAL_UPGRADE = /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+npm@([^\s'"`;&|]+)/gu;

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

function findAction(actions: readonly SetupActionKnowledge[], uses: string): SetupActionKnowledge | undefined {
  const name = uses.split('@', 1)[0]?.toLowerCase();
  return actions.find((action) => action.action.toLowerCase() === name);
}

export function readWorkflows(repository: Repository, facts: DetectionFacts): WorkflowFindings {
  const { directory, extensions } = facts.workflows;
  const files = repository
    .listFiles(directory)
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => joinPath(directory, name));
  const findings: WorkflowFindings = { files, versions: [], installs: [] };

  for (const file of files) {
    const text = repository.readText(file);
    if (text === undefined) continue;
    const lineCounter = new LineCounter();
    const document = parseDocument(text, { lineCounter });
    if (document.errors.length > 0) {
      const message = document.errors[0]?.message.split('\n', 1)[0] ?? 'invalid YAML';
      repository.warn('invalid-file', `cannot parse ${file}: ${message}`, [file]);
      continue;
    }
    const lineOf = (node: Node) => (node.range === undefined || node.range === null ? undefined : lineCounter.linePos(node.range[0]).line);
    const declare = (tool: RuntimeOrTool, value: { version: string } | { versionFile: string }, node: Node) => {
      const line = lineOf(node);
      findings.versions.push({ tool, declaration: { ...value, source: 'github-actions', file, ...(line === undefined ? {} : { line }) } });
    };

    const jobs = document.get('jobs');
    if (!isMap(jobs)) continue;
    for (const job of jobs.items) {
      const steps = isMap(job.value) ? job.value.get('steps') : undefined;
      if (!isSeq(steps)) continue;
      for (const step of steps.items) {
        if (!isMap(step)) continue;
        const uses = scalarText(step.get('uses', true));
        const action = uses === undefined ? undefined : findAction(facts.setupActions, uses);
        if (action !== undefined) {
          for (const tool of action.installs) findings.installs.push({ tool, file });
          const inputs = step.get('with');
          if (isMap(inputs)) {
            for (const input of action.inputs) {
              const node = inputs.get(input.name, true);
              const value = scalarText(node);
              if (value === undefined || !isScalar(node)) continue;
              if (input.kind === 'version' && input.tool !== undefined) declare(input.tool, { version: value }, node);
              if (input.kind === 'version-file' && input.tool !== undefined) declare(input.tool, { versionFile: value }, node);
              if (input.kind === 'runtime') {
                const [name, version] = value.split('@');
                if ((name === 'node' || name === 'bun' || name === 'deno') && version !== undefined && version !== '') {
                  declare(name, { version }, node);
                }
              }
            }
          }
        }
        const run = step.get('run', true);
        if (isScalar(run) && typeof run.value === 'string' && run.range !== undefined && run.range !== null) {
          // Search the source text of the step so that matches inside block scalars get their own line.
          const source = text.slice(run.range[0], run.range[1]);
          for (const match of source.matchAll(NPM_GLOBAL_UPGRADE)) {
            const line = lineCounter.linePos(run.range[0] + match.index).line;
            findings.versions.push({ tool: 'npm', declaration: { version: match[1] ?? '', source: 'github-actions', file, line } });
          }
        }
      }
    }
  }
  return findings;
}
