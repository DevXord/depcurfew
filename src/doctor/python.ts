// Where Python tools read their settings in a project, for doctor: uv reads uv.toml, or [tool.uv] of pyproject.toml
// when there is no uv.toml; Poetry reads poetry.toml; pip reads only the requirements file it is given. Files and
// tables come from the knowledge base.
import { extraOf, isRecord, values } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import { parseToml, type TomlValue } from '../detect/toml.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import type { Setting } from './settings.ts';

function tomlSettingAt(repository: Repository, file: string, path: readonly string[]): Setting | undefined {
  if (!repository.isFile(file)) return undefined;
  const text = repository.readText(file);
  if (text === undefined) return undefined;
  let document;
  try {
    document = parseToml(text);
  } catch {
    // unreadable-config reports files that do not parse.
    return undefined;
  }
  let node: TomlValue | undefined = document.root;
  for (const key of path) node = isRecord(node) ? (node as Record<string, TomlValue>)[key] : undefined;
  if (node === undefined) return undefined;
  return { file, line: document.lineOf(path) ?? 1, value: node };
}

/** The files and key paths where a Python tool reads `setting`, in the order the tool uses them. */
export function pythonSettingPaths(repository: Repository, tool: ToolKnowledge, setting: string): { file: string; path: string[] }[] {
  const tables = tool.extra?.['configTables'] === undefined ? undefined : extraOf(tool, 'configTables', isRecord);
  if (tables !== undefined) {
    // uv: uv.toml when it exists, otherwise the table in pyproject.toml.
    const files = Object.keys(tables).sort((a, b) => Number(a === 'pyproject.toml') - Number(b === 'pyproject.toml'));
    const file = files.find((name) => repository.isFile(name)) ?? files[0];
    if (file === undefined) return [];
    const table = String(tables[file] ?? '');
    return [{ file, path: [...(table === '' ? [] : table.split('.')), setting] }];
  }
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  return file === undefined || !file.endsWith('.toml') ? [] : [{ file, path: setting.split('.') }];
}

/** A Python tool's setting as the tool reads it in the project, or undefined when it is not set. */
export function readPythonSetting(repository: Repository, tool: ToolKnowledge, setting: string): Setting | undefined {
  for (const { file, path } of pythonSettingPaths(repository, tool, setting)) {
    const found = tomlSettingAt(repository, file, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The option lines of a requirements file, e.g. --only-binary=:all:, with their values and lines. */
export function requirementsOptions(repository: Repository, file: string): { option: string; value: string; line: number }[] {
  const text = repository.readText(file);
  if (text === undefined) return [];
  return text.split(/\r?\n/u).flatMap((raw, index) => {
    const match = /^\s*(--[a-z-]+)(?:[=\s]\s*(\S+))?/u.exec(raw);
    return match === null ? [] : [{ option: match[1] ?? '', value: match[2] ?? '', line: index + 1 }];
  });
}
