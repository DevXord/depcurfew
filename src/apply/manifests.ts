// apply never creates a project manifest (package.json, deno.json, pyproject.toml, Pipfile …): a new one turns the
// directory into a project of that tool, and one holding only depcurfew's settings is not a valid manifest (a
// pyproject.toml without [project]). Configuration files of the tools (.npmrc, bunfig.toml, uv.toml …) are still
// created. Edits of a missing manifest are skipped and reported per tool (decision D-075).
import { parseJsonc } from '../detect/jsonc.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { isRecord } from './facts.ts';
import { listing } from './requirements.ts';
import { manifestsOf } from './targets.ts';
import { Workspace } from './workspace.ts';

export interface SkippedManifest {
  file: string;
  /** The settings that were not written, e.g. "trustedDependencies" or "exclude-newer in [tool.pdm.resolution]". */
  settings: string[];
  /** How many keys those are. */
  count: number;
}

/** Every manifest name the knowledge base records, for any tool. */
export function manifestNames(tools: readonly ToolKnowledge[]): Set<string> {
  return new Set(tools.flatMap(manifestsOf));
}

/** The settings in what would have been written: top-level JSON keys, or TOML keys with their table. */
function settingsIn(file: string, text: string): { settings: string[]; count: number } {
  if (/\.json[c5]?$/u.test(file)) {
    try {
      const parsed = parseJsonc(text);
      const keys = isRecord(parsed) ? Object.keys(parsed) : [];
      return { settings: keys, count: keys.length };
    } catch {
      return { settings: [], count: 0 };
    }
  }
  const byTable = new Map<string, string[]>();
  let table = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]/u.exec(line);
    if (header !== null) table = header[1] ?? '';
    else if (line !== '' && !line.startsWith('#') && line.includes('=')) {
      byTable.set(table, [...(byTable.get(table) ?? []), line.slice(0, line.indexOf('=')).trim()]);
    }
  }
  return {
    settings: [...byTable].map(([name, keys]) => (name === '' ? listing(keys) : `${listing(keys)} in [${name}]`)),
    count: [...byTable.values()].reduce((sum, keys) => sum + keys.length, 0),
  };
}

/** A workspace that leaves missing manifests alone and remembers what each tool wanted to write into them. */
export class ManifestGuard extends Workspace {
  readonly #manifests: ReadonlySet<string>;
  readonly #skipped = new Map<string, string>();
  #tool: ToolId | undefined;

  constructor(root: string, manifests: ReadonlySet<string>) {
    super(root);
    this.#manifests = manifests;
  }

  /** The tool whose edits follow; skipped edits are collected per tool. */
  startTool(tool: ToolId): void {
    this.#tool = tool;
    this.#skipped.clear();
  }

  override edit(file: string, change: (body: string) => string): void {
    const name = file.split('/').at(-1) ?? file;
    if (this.#tool === undefined || !this.#manifests.has(name) || this.exists(file)) {
      super.edit(file, change);
      return;
    }
    // What the edits would have produced, only to name the settings; an edit that fails on it is ignored.
    try {
      this.#skipped.set(file, change(this.#skipped.get(file) ?? ''));
    } catch {
      this.#skipped.set(file, this.#skipped.get(file) ?? '');
    }
  }

  /** The manifests the current tool could not write into. */
  skipped(): SkippedManifest[] {
    return [...this.#skipped].map(([file, text]) => ({ file, ...settingsIn(file, text) }));
  }
}
