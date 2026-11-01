// Dockerfiles and Containerfiles: which official node or python image each build stage starts from, and where npm
// and pip install packages or are replaced. File names, image names and tags come from the knowledge base.
import type { DockerfileSyntaxKnowledge, ImageReferenceKnowledge, RuntimeImageKnowledge } from '../knowledge/types.ts';
import { findExecCommands, findToolCommands, overLimitMessages, withVariables, type CommandFacts, type Environment, type ScriptCommands, type Word } from './commands.ts';
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
  /** ENV and how stages inherit it (decision D-115). */
  environment: { instruction: string; inheritedByStages: boolean; spaceForm: boolean };
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

/** The official node or python image a reference names, with the version of its tag; also for jobs.<id>.container. */
export function imageRuntime(reference: string, facts: DockerFacts): StageRuntime | undefined {
  return runtimeOf(reference, facts);
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

/**
 * A here-document body is a script when it is fed to a shell: RUN <<EOF, or RUN <<EOF bash, or RUN bash -e <<EOF. The
 * other words of its command are few (the reader keeps at most 16), so the test is short.
 */
function isScript(command: string | undefined): boolean {
  return command !== undefined && (command === '' || /^(?:\S*\/)?(?:sh|bash|ash|dash|zsh)(?: -\S+)*$/u.test(command));
}

/** A command as found, with the directory of its cd (relative to the working directory) as `directory`. */
function located({ cd, ...command }: Omit<ToolCommand, 'line'> & { cd?: string }, line: number): ToolCommand {
  return { ...command, line, ...(cd === undefined ? {} : { directory: cd }) };
}

/**
 * ENV NAME=value [NAME2=value2 ...], or the older ENV NAME value: the variables it sets, quotes removed. A value with $
 * is kept as written (depcurfew does not expand it, so it never reads as true).
 */
export function envDeclarations(text: string, spaceForm: boolean): [string, string][] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (char === ' ' || char === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      const close = end < 0 ? text.length : end;
      word += text.slice(index + 1, close);
      inWord = true;
      index = close;
    } else if (char === '\\' && index + 1 < text.length) {
      word += text[index + 1] ?? '';
      inWord = true;
      index += 1;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  const first = words[0];
  if (first === undefined) return [];
  if (!first.includes('=')) return spaceForm && words.length > 1 ? [[first, words.slice(1).join(' ')]] : [];
  return words.flatMap((item): [string, string][] => {
    const equals = item.indexOf('=');
    return equals > 0 ? [[item.slice(0, equals), item.slice(equals + 1)]] : [];
  });
}

function runCommands(instruction: Instruction, facts: DockerFacts, environment: Environment): { commands: ToolCommand[]; pipConfig?: true; overLimit?: ScriptCommands['overLimit'] } {
  const commands: ToolCommand[] = [];
  const { text, offset } = withoutOptions(instruction.text);
  const exec = execWords(text);
  if (exec !== undefined) {
    const words: Word[] = exec.map((word) => ({ text: word, offset: 0 }));
    const found = findExecCommands(words, facts.commands, environment);
    for (const { offset: _offset, ...command } of found.commands) commands.push(located(command, instruction.line));
    return { commands, ...(found.pipConfig === true ? { pipConfig: true as const } : {}) };
  }
  const found = findToolCommands(text, facts.commands, 0, environment);
  let pipConfig = found.pipConfig === true;
  const overLimit: NonNullable<ScriptCommands['overLimit']> = { ...found.overLimit };
  for (const { offset: at, ...command } of found.commands) commands.push(located(command, lineAt(instruction, offset + at)));
  for (const heredoc of instruction.heredocs) {
    if (!isScript(heredoc.command)) continue;
    const lineStarts = [0];
    for (let index = heredoc.body.indexOf('\n'); index >= 0; index = heredoc.body.indexOf('\n', index + 1)) lineStarts.push(index + 1);
    const body = findToolCommands(heredoc.body, facts.commands, 0, environment);
    pipConfig ||= body.pipConfig === true;
    if (body.overLimit?.directory !== undefined) overLimit.directory ??= body.overLimit.directory;
    if (body.overLimit?.variables === true) overLimit.variables = true;
    for (const { offset: at, ...command } of body.commands) {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= at) low = middle;
        else high = middle - 1;
      }
      commands.push(located(command, heredoc.line + low));
    }
  }
  return { commands, ...(pipConfig ? { pipConfig: true as const } : {}), ...(Object.keys(overLimit).length === 0 ? {} : { overLimit }) };
}

/** The most COPY and ADD sources kept for one stage. */
const MAX_COPIES = 256;

/**
 * The sources of a COPY or ADD instruction from the build context: every word but the last (the destination), without
 * options and here-documents, in shell or exec form. Nothing for --from (another stage or image).
 */
function copySources(text: string): string[] {
  const { text: rest, offset } = withoutOptions(text.trim());
  if (/(?:^|\s)--from\b/iu.test(text.trim().slice(0, offset))) return [];
  const words = execWords(rest.trim()) ?? rest.trim().split(/\s+/u).filter(Boolean);
  return words.slice(0, -1).filter((word) => !word.startsWith('<<')).slice(0, MAX_COPIES);
}

export interface DockerfileReading {
  info: DockerfileInfo;
  /** Node.js from FROM, npm, pip and Poetry from RUN (npm install -g npm@X, pip install pip==X, pipx install poetry==X). */
  versions: { tool: 'node' | 'npm' | 'pip' | 'poetry'; declaration: VersionDeclaration }[];
  /** RUN instructions that went over a limit of the command reader, as the notices say it (decision D-121), with the line of the instruction (decision D-124). */
  notices: { message: string; line: number }[];
}

/** Reads one Dockerfile. */
export function readDockerStages(file: string, text: string, facts: DockerFacts): DockerfileReading {
  const instructions = readDockerfile(text, facts.syntax);
  const escape = facts.syntax.escapeCharacters[0] ?? '\\';
  const args = new Map<string, string | undefined>();
  // ARGs whose value depcurfew does not read (too long after substitution), with the reason.
  const unreadable = new Map<string, string>();
  const stages: DockerStage[] = [];
  // The first stage of each name, for FROM <name>.
  const named = new Map<string, number>();
  // The variables ENV sets in each stage, which the stages that start from it inherit (docker.environment); only those
  // that commands read are kept (decision D-121).
  const environments: Environment[] = [];
  const versions: DockerfileReading['versions'] = [];
  const notices: DockerfileReading['notices'] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === facts.syntax.globalArgInstruction && stages.length === 0) {
      for (const [name, value] of argDeclarations(instruction.text)) {
        const resolved = value === undefined ? undefined : substitute(value, args, escape, unreadable);
        args.set(name, resolved?.ok === true ? resolved.value : undefined);
        const why = resolved?.ok === false ? resolved.reason : undefined;
        if (why !== undefined) unreadable.set(name, why.startsWith('it ') ? `the ARG ${name} ${why.slice(3)}` : why);
        else unreadable.delete(name);
      }
      continue;
    }
    if (instruction.keyword === 'FROM') {
      const words = instruction.text.split(/\s+/u).filter(Boolean);
      const position = words.findIndex((word) => !word.startsWith('--'));
      const written = words[position] ?? '';
      const alias = words[position + 1]?.toLowerCase() === 'as' ? words[position + 2]?.toLowerCase() : undefined;
      const stage: DockerStage = { line: instruction.line, ...(alias === undefined ? {} : { name: alias }), commands: [] };
      const substituted = substitute(written, args, escape, unreadable);
      if (!substituted.ok) {
        // The tag may come from an ARG without a value; the image name may still show the official image.
        const reference = written.split('@', 1)[0] ?? '';
        const colon = reference.lastIndexOf(':');
        const name = colon > reference.lastIndexOf('/') ? reference.slice(0, colon) : reference;
        const runtime = name.includes('$') || name.length > 256 ? undefined : runtimeOf(name, facts);
        const why = substituted.reason;
        const reason = why === undefined ? `the ARG ${substituted.variable} it uses has no value in the Dockerfile` : why.startsWith('it ') ? `the image reference ${why.slice(3)}` : why;
        if (runtime !== undefined) stage.runtime = { tool: runtime.tool, unknown: reason };
      } else {
        stage.image = substituted.value;
        const earlier = named.get(substituted.value.toLowerCase()) ?? -1;
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
      if (alias !== undefined && !named.has(alias)) named.set(alias, stages.length);
      const parent = stage.from === undefined || !facts.environment.inheritedByStages ? undefined : environments[stage.from];
      environments.push(parent ?? new Map());
      stages.push({ ...fields, commands: [] });
      continue;
    }
    const stage = stages.at(-1);
    const environment = environments.at(-1);
    if (instruction.keyword === facts.environment.instruction && environment !== undefined) {
      environments[environments.length - 1] = withVariables(facts.commands, environment, envDeclarations(instruction.text, facts.environment.spaceForm));
      continue;
    }
    if ((instruction.keyword === 'COPY' || instruction.keyword === 'ADD') && stage !== undefined) {
      const sources = copySources(instruction.text);
      if (sources.length > 0) stage.copies = [...(stage.copies ?? []), ...sources].slice(0, MAX_COPIES);
      continue;
    }
    if (instruction.keyword !== 'RUN' || stage === undefined) continue;
    const run = runCommands(instruction, facts, environment ?? new Map());
    if (run.pipConfig === true) stage.pipConfig = true;
    for (const message of overLimitMessages(run.overLimit, `the RUN instruction in ${file} (line ${instruction.line})`)) notices.push({ message, line: instruction.line });
    for (const command of run.commands) {
      stage.commands.push(command);
      if (command.kind === 'upgrade' && command.version !== undefined && (command.tool === 'npm' || command.tool === 'pip' || command.tool === 'poetry')) {
        versions.push({ tool: command.tool, declaration: { version: command.version, source: 'dockerfile', file, line: command.line, stage: stage.name ?? String(stages.length - 1) } });
      }
    }
  }
  return { info: { file, stages }, versions, notices };
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
