// Dockerfiles and Containerfiles: which official node or python image each build stage starts from, and where npm
// and pip install packages or are replaced. File names, image names and tags come from the knowledge base.
import type { DockerfileSyntaxKnowledge, ImageReferenceKnowledge, RuntimeImageKnowledge } from '../knowledge/types.ts';
import { findExecCommands, findToolCommands, type CommandFacts, type Word } from './commands.ts';
import { argDeclarations, lineAt, readDockerfile, substitute, type Instruction } from './dockerfile.ts';
import { joinPath, type Repository } from './repository.ts';
import type { DockerfileInfo, DockerStage, StageRuntime, ToolCommand, VersionDeclaration } from './types.ts';

export interface DockerFacts {
  syntax: DockerfileSyntaxKnowledge;
  reference: ImageReferenceKnowledge;
  /** Dockerfile, the suffix .Dockerfile, the prefix Dockerfile. and Containerfile. */
  names: { exact: readonly string[]; suffix: string; prefix: string };
  node: RuntimeImageKnowledge;
  python: RuntimeImageKnowledge;
  /** Moving tags of the node image (lts, current, latest) and of the python image (latest, 3). */
  nodeTags: Readonly<Record<string, string>>;
  pythonTags: Readonly<Record<string, string>>;
  /** LTS codenames of Node.js, in lower case. */
  codenames: readonly string[];
  commands: CommandFacts;
}

const IGNORE_FILE = '.dockerignore';

export function isDockerfileName(name: string, facts: DockerFacts): boolean {
  if (name.endsWith(IGNORE_FILE)) return false;
  return facts.names.exact.includes(name) || (name.endsWith(facts.names.suffix) && name.length > facts.names.suffix.length) || (name.startsWith(facts.names.prefix) && name.length > facts.names.prefix.length);
}

/** An image reference split into the repository on Docker Hub (when it is there), the tag and the digest. */
function splitReference(reference: string, facts: DockerFacts): { repository: string; hub: boolean; tag?: string; digest?: string } {
  const [named = '', digest] = reference.split('@', 2);
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const tag = colon > slash ? named.slice(colon + 1) : undefined;
  const name = colon > slash ? named.slice(0, colon) : named;
  const parts = name.split('/');
  const host = parts.length > 1 && /[.:]|^localhost$/u.test(parts[0] ?? '') ? parts[0] : undefined;
  const path = host === undefined ? parts : parts.slice(1);
  const hub = host === undefined || facts.reference.hosts.includes(host.toLowerCase());
  const namespace = facts.reference.officialNamespace;
  const repository = hub && path.length === 2 && path[0] === namespace ? (path[1] ?? '') : path.join('/');
  return { repository, hub, ...(tag === undefined ? {} : { tag }), ...(digest === undefined ? {} : { digest }) };
}

/** The version a node tag names: 22-alpine is 22, lts-jod is jod, alpine alone is the current line. */
function nodeTagVersion(tag: string, facts: DockerFacts): string | undefined {
  const numbered = /^(\d+(?:\.\d+){0,2})(?:-.+)?$/u.exec(tag);
  if (numbered !== null) return numbered[1];
  const [head = '', ...rest] = tag.split('-');
  if (head === 'lts' && rest[0] !== undefined && facts.codenames.includes(rest[0])) return rest[0];
  if (Object.hasOwn(facts.nodeTags, head) || facts.codenames.includes(head)) return head;
  return facts.node.variants.includes(tag) || facts.node.variants.includes(head) ? 'current' : undefined;
}

/** The version a python tag names: 3.12-slim is 3.12, slim alone is latest; release candidates are not versions. */
function pythonTagVersion(tag: string, facts: DockerFacts): string | undefined {
  const numbered = /^(\d+(?:\.\d+){0,2})(?:-(.+))?$/u.exec(tag);
  if (numbered !== null) return numbered[2]?.split('-').includes('rc') === true ? undefined : numbered[1];
  if (Object.hasOwn(facts.pythonTags, tag)) return tag;
  return facts.python.variants.includes(tag) || facts.python.variants.some((variant) => tag.startsWith(`${variant}-`)) ? 'latest' : undefined;
}

function runtimeOf(reference: string, facts: DockerFacts): StageRuntime | undefined {
  const { repository, hub, tag, digest } = splitReference(reference, facts);
  if (!hub) return undefined;
  const tool = repository === facts.node.image ? 'node' : repository === facts.python.image ? 'python' : undefined;
  if (tool === undefined) return undefined;
  if (tag === undefined && digest !== undefined) return { tool, unknown: `the image is pinned by digest only (${reference})` };
  const used = tag ?? facts.reference.defaultTag;
  const version = tool === 'node' ? nodeTagVersion(used, facts) : pythonTagVersion(used, facts);
  return version === undefined
    ? { tool, ...(tag === undefined ? {} : { tag }), unknown: `depcurfew does not know the tag ${used}` }
    : { tool, ...(tag === undefined ? {} : { tag }), version };
}

/** Words of a RUN instruction in exec form (RUN ["npm", "ci"]), or undefined for the shell form. */
function execWords(text: string): string[] | undefined {
  if (!text.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a RUN instruction without its options (--mount=..., --network=...). */
function withoutOptions(text: string): { text: string; offset: number } {
  let offset = 0;
  for (;;) {
    const option = /^--\S*\s*/u.exec(text.slice(offset));
    if (option === null) return { text: text.slice(offset), offset };
    offset += option[0].length;
  }
}

/** A here-document body is a script when it is fed to a shell: RUN <<EOF, or RUN <<EOF bash, or RUN bash <<EOF. */
function isScript(before: string): boolean {
  return before === '' || /^(?:\S*\/)?(?:sh|bash|ash|dash|zsh)(?:\s+-\S+)*$/u.test(before);
}

function runCommands(instruction: Instruction, facts: DockerFacts): { commands: ToolCommand[] } {
  const commands: ToolCommand[] = [];
  const { text, offset } = withoutOptions(instruction.text);
  const exec = execWords(text);
  if (exec !== undefined) {
    const words: Word[] = exec.map((word) => ({ text: word, offset: 0 }));
    for (const { offset: _offset, ...command } of findExecCommands(words, facts.commands).commands) commands.push({ ...command, line: instruction.line });
    return { commands };
  }
  for (const { offset: at, ...command } of findToolCommands(text, facts.commands).commands) commands.push({ ...command, line: lineAt(instruction, offset + at) });
  for (const heredoc of instruction.heredocs) {
    if (!isScript(heredoc.before.replace(/<<-?["']?[A-Za-z_][A-Za-z0-9_.-]*["']?/gu, '').trim())) continue;
    const lineStarts = [0];
    for (let index = heredoc.body.indexOf('\n'); index >= 0; index = heredoc.body.indexOf('\n', index + 1)) lineStarts.push(index + 1);
    for (const { offset: at, ...command } of findToolCommands(heredoc.body, facts.commands).commands) {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= at) low = middle;
        else high = middle - 1;
      }
      commands.push({ ...command, line: heredoc.line + low });
    }
  }
  return { commands };
}

export interface DockerfileReading {
  info: DockerfileInfo;
  /** Node.js from FROM, npm and pip from RUN (npm install -g npm@X, pip install pip==X). */
  versions: { tool: 'node' | 'npm' | 'pip'; declaration: VersionDeclaration }[];
}

/** Reads one Dockerfile. */
export function readDockerStages(file: string, text: string, facts: DockerFacts): DockerfileReading {
  const instructions = readDockerfile(text, facts.syntax);
  const escape = facts.syntax.escapeCharacters[0] ?? '\\';
  const args = new Map<string, string | undefined>();
  const stages: DockerStage[] = [];
  const versions: DockerfileReading['versions'] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === facts.syntax.globalArgInstruction && stages.length === 0) {
      for (const [name, value] of argDeclarations(instruction.text)) {
        const resolved = value === undefined ? undefined : substitute(value, args, escape);
        args.set(name, resolved?.ok === true ? resolved.value : undefined);
      }
      continue;
    }
    if (instruction.keyword === 'FROM') {
      const words = instruction.text.split(/\s+/u).filter(Boolean);
      const position = words.findIndex((word) => !word.startsWith('--'));
      const written = words[position] ?? '';
      const alias = words[position + 1]?.toLowerCase() === 'as' ? words[position + 2]?.toLowerCase() : undefined;
      const stage: DockerStage = { line: instruction.line, ...(alias === undefined ? {} : { name: alias }), commands: [] };
      const substituted = substitute(written, args, escape);
      if (!substituted.ok) {
        // The tag may come from an ARG without a value; the image name may still show the official image.
        const named = written.split('@', 1)[0] ?? '';
        const colon = named.lastIndexOf(':');
        const name = colon > named.lastIndexOf('/') ? named.slice(0, colon) : named;
        const runtime = name.includes('$') ? undefined : runtimeOf(name, facts);
        if (runtime !== undefined) stage.runtime = { tool: runtime.tool, unknown: `the ARG ${substituted.variable} it uses has no value in the Dockerfile` };
      } else {
        stage.image = substituted.value;
        const earlier = stages.findIndex((other) => other.name !== undefined && other.name === substituted.value.toLowerCase());
        if (earlier >= 0) {
          stage.from = earlier;
          const inherited = stages[earlier]?.runtime;
          if (inherited !== undefined) stage.runtime = inherited;
        } else {
          const runtime = runtimeOf(substituted.value, facts);
          if (runtime !== undefined) {
            stage.runtime = runtime;
            if (runtime.tool === 'node' && runtime.version !== undefined) {
              versions.push({ tool: 'node', declaration: { version: runtime.version, source: 'dockerfile', file, line: instruction.line, stage: alias ?? String(stages.length) } });
            }
          }
        }
      }
      const { commands: _commands, ...fields } = stage;
      stages.push({ ...fields, commands: [] });
      continue;
    }
    const stage = stages.at(-1);
    if (instruction.keyword !== 'RUN' || stage === undefined) continue;
    for (const command of runCommands(instruction, facts).commands) {
      stage.commands.push(command);
      if (command.kind === 'upgrade' && command.version !== undefined) {
        versions.push({ tool: command.tool, declaration: { version: command.version, source: 'dockerfile', file, line: command.line, stage: stage.name ?? String(stages.length - 1) } });
      }
    }
  }
  return { info: { file, stages }, versions };
}

/**
 * The Dockerfiles of the root, of its direct subdirectories that have no manifest of their own (docker/, .devcontainer/),
 * and of workspace packages, sorted by path.
 */
export function dockerfileCandidates(repository: Repository, facts: DockerFacts, manifests: readonly string[], packages: readonly string[]): string[] {
  const directories = new Set(['.', ...packages]);
  for (const name of repository.listDirectories('.')) {
    if (!manifests.some((manifest) => repository.isFile(joinPath(name, manifest)))) directories.add(name);
  }
  const files: string[] = [];
  for (const directory of directories) {
    for (const name of repository.listFiles(directory)) if (isDockerfileName(name, facts)) files.push(joinPath(directory, name));
  }
  return [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
