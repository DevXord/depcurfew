// Where Python tools read their settings in a project, for doctor: uv reads uv.toml, or [tool.uv] of pyproject.toml
// when there is no uv.toml; Poetry reads poetry.toml; pip reads only the requirements file it is given. Files and
// tables come from the knowledge base. The repository parses each TOML file once, because several rules read them.
import { extraOf, isRecord, values } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import { parseToml, tomlValueAt, type TomlDocument } from '../detect/toml.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { requirementsLines } from './python-lockfiles.ts';
import type { Setting } from './settings.ts';

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The parsed TOML file, or undefined when it is missing or does not parse (unreadable-config then reports it). */
export function readTomlDocument(repository: Repository, file: string): TomlDocument | undefined {
  return repository.parseOnce(file, parseToml);
}

/** The value at a key path of a TOML file, with the line of its key. */
export function tomlSettingAt(repository: Repository, file: string, path: readonly string[]): Setting | undefined {
  const document = readTomlDocument(repository, file);
  const value = document === undefined ? undefined : tomlValueAt(document, path);
  return document === undefined || value === undefined ? undefined : { file, line: document.lineOf(path) ?? 1, value };
}

/** The files and key paths where a Python tool reads `setting`, in the order the tool uses them. */
export function pythonSettingPaths(repository: Repository, tool: ToolKnowledge, setting: string): { file: string; path: string[] }[] {
  const tables = tool.extra?.['configTables'] === undefined ? undefined : extraOf(tool, 'configTables', isRecord);
  if (tables !== undefined) {
    // uv: the first file of configFileOrder that exists (uv.toml wins over [tool.uv] in pyproject.toml).
    const order = tool.extra?.['configFileOrder'] === undefined ? Object.keys(tables) : extraOf(tool, 'configFileOrder', isStringList);
    const files = order.filter((name) => name in tables);
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

/**
 * The global option lines of a requirements file, e.g. --only-binary=:all:, with their values and lines. Options after
 * a requirement on the same logical line (--hash on a continuation line) belong to that requirement and are skipped.
 */
export function requirementsOptions(repository: Repository, file: string, format: Record<string, unknown>): { option: string; value: string; line: number }[] {
  const text = repository.readText(file);
  if (text === undefined) return [];
  return requirementsLines(text, format).flatMap(({ text: line, line: number }) => {
    const match = /^(--[a-z-]+)(?:[=\s]\s*(\S+))?/u.exec(line);
    return match === null ? [] : [{ option: match[1] ?? '', value: match[2] ?? '', line: number }];
  });
}
