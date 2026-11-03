// Keys of INI user files as the tool reads them (decision D-170): pip takes only_binary, ONLY-BINARY and --only-binary
// for only-binary (UserFile.underscoresAsDashes), and stops on a file that has a section twice or a key twice in one
// section (UserFile.duplicateKeys), which its parser, Python's configparser in strict mode, does not accept.
import type { UserFile } from '../knowledge/types.ts';

/** A key as pip reads it: in lower case, with dashes for underscores and without a leading -- (_normalize_name). */
export function dashedKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '-').replace(/^--/u, '');
}

/** A key of an INI user file as the tool reads it. */
export function iniKeyAsRead(file: UserFile, key: string): string {
  return file.underscoresAsDashes === true ? dashedKey(key) : key;
}

/** A line that sets a key or opens a section, as written. */
export interface IniPlace {
  /** The key as written, or the section name. */
  text: string;
  line: number;
}

/** A section given twice in one file, or a key given twice in one section. */
export type IniRepeat =
  | { kind: 'section'; section: string; first: IniPlace; second: IniPlace }
  | { kind: 'key'; section: string; key: string; first: IniPlace; second: IniPlace };

/** configparser's default section: a [DEFAULT] header may stand more than once. */
const DEFAULT_SECTION = 'DEFAULT';
const COMMENT = /^[#;]/u;
// SECTCRE of configparser: [ and the first ] after it, on the line without its leading and trailing spaces.
const SECTION = /^\[([^\]]+)\]/u;
// OPTCRE: the key is everything before the first = or :.
const OPTION = /^(.*?)\s*[=:]/u;

/**
 * The first section or key a file gives twice, read as configparser reads it: comment lines are skipped, a line indented
 * deeper than the key above it continues that key's value, a section header resets that, and keys are compared in
 * lower case, or as the tool reads them with `as-read`. Undefined when the tool accepts repeats or there are none.
 */
export function repeatedIniKey(file: UserFile, text: string): IniRepeat | undefined {
  if (file.format !== 'ini' || file.duplicateKeys === undefined) return undefined;
  const normalize = file.duplicateKeys === 'as-read' ? dashedKey : (key: string) => key.toLowerCase();
  const sections = new Map<string, IniPlace>();
  // The keys of each section; those of a [DEFAULT] given again count with the ones before it.
  const keysOf = new Map<string, Map<string, IniPlace>>();
  let section: string | undefined;
  let indent: number | undefined;
  const lines = text.split(/\r\n|\r|\n/u);
  for (const [index, raw] of lines.entries()) {
    const value = raw.trim();
    if (value === '' || COMMENT.test(value)) continue;
    const level = raw.length - raw.trimStart().length;
    // A continuation line belongs to the value of the key above it.
    if (section !== undefined && indent !== undefined && level > indent) continue;
    const line = index + 1;
    const header = SECTION.exec(value);
    if (header !== null) {
      const name = header[1] ?? '';
      const known = sections.get(name);
      if (known !== undefined && name !== DEFAULT_SECTION) return { kind: 'section', section: name, first: known, second: { text: name, line } };
      if (known === undefined) sections.set(name, { text: name, line });
      section = name;
      indent = undefined;
      continue;
    }
    if (section === undefined) continue;
    const option = OPTION.exec(value);
    const written = (option?.[1] ?? '').trimEnd();
    if (written === '') continue;
    indent = level;
    const key = normalize(written);
    const keys = keysOf.get(section) ?? new Map<string, IniPlace>();
    keysOf.set(section, keys);
    const known = keys.get(key);
    if (known !== undefined) return { kind: 'key', section, key, first: known, second: { text: written, line } };
    keys.set(key, { text: written, line });
  }
  return undefined;
}
