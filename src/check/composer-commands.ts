// Composer's command line as Composer reads it before it knows the command (decision D-136): the options of the
// application it binds first (extra.applicationOptions), the command word getFirstArgument then picks, and the command
// that word stands for as symfony/console's Application::find resolves it (extra.commandNames), also with the scripts
// of the composer.json the command runs with registered as commands (extra.scriptCommands). Read from symfony/console
// v5.4.55 (Application.php, Input/ArgvInput.php, Command/Command.php), the version Composer 2.11.1 locks.
import type { ApplicationOption, CommandNamesKnowledge, ComposerScriptCommandsKnowledge } from '../knowledge/types.ts';

/** What a command word stands for: a command of Composer (by its name) or a script of composer.json. */
export type FoundCommand = { kind: 'command' | 'script'; name: string };

/** The scripts of composer.json that Composer registers as commands, with their aliases (scripts-aliases), in order. */
export interface ScriptCommands {
  scripts: readonly { name: string; aliases: readonly string[] }[];
}

/** PHP's strtolower: ASCII letters only, as PCRE's i without u compares them. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/**
 * Whether a name matches the word as find() compares them: each part of the word between colons starts its part of
 * the name; `whole`: the name has as many parts as the word (the anchored pattern), else it may have more.
 */
function matchesParts(name: string, parts: readonly string[], fold: boolean, whole: boolean): boolean {
  const segments = name.split(':');
  if (segments.length < parts.length || (whole && segments.length !== parts.length)) return false;
  return parts.every((part, index) => {
    const segment = segments[index] ?? '';
    return fold ? lowerAscii(segment).startsWith(lowerAscii(part)) : segment.startsWith(part);
  });
}

/**
 * The command a word stands for, as Application::find resolves it: an exact name or alias; else every name and alias
 * that starts with the word, part by part (first with case, then without), of which one must match the word whole
 * without case; an alias is left out when the name of its command is in the list too, a hidden command when others
 * remain, and one must be left. undefined: the word is ambiguous or names no command, and Composer runs nothing.
 * Scripts are added as Application::add adds them: a script whose name is taken is skipped, and its aliases replace
 * those of other commands.
 */
export function findComposerCommand(names: CommandNamesKnowledge, word: string, scripts?: ScriptCommands): FoundCommand | undefined {
  const map = new Map<string, FoundCommand>();
  for (const name of names.commands) map.set(name, { kind: 'command', name });
  for (const [alias, target] of Object.entries(names.aliases)) {
    let name = target;
    for (let step = 0; step < 8 && !names.commands.includes(name) && Object.hasOwn(names.aliases, name); step++) name = names.aliases[name] as string;
    map.set(alias, { kind: 'command', name });
  }
  for (const script of scripts?.scripts ?? []) {
    if (map.has(script.name)) continue;
    const found: FoundCommand = { kind: 'script', name: script.name };
    map.set(script.name, found);
    for (const alias of script.aliases) map.set(alias, found);
  }
  const exact = map.get(word);
  if (exact !== undefined) return exact;
  const parts = word.split(':');
  const keys = [...map.keys()];
  let matched = keys.filter((key) => matchesParts(key, parts, false, false));
  if (matched.length === 0) matched = keys.filter((key) => matchesParts(key, parts, true, false));
  if (matched.length === 0 || !matched.some((key) => matchesParts(key, parts, true, true))) return undefined;
  if (matched.length > 1) {
    const all = matched;
    matched = all.filter((key) => {
      const target = map.get(key)?.name ?? key;
      return target === key || !all.includes(target);
    });
  }
  const hidden = new Set(names.hidden ?? []);
  if (matched.length > 1) matched = matched.filter((key) => !(map.get(key)?.kind === 'command' && hidden.has(map.get(key)?.name ?? '')));
  if (matched.length !== 1) return undefined;
  const found = map.get(matched[0] as string);
  return found === undefined || (found.kind === 'command' && hidden.has(found.name)) ? undefined : found;
}

/**
 * The scripts of a composer.json that Composer registers as commands (Application::doRunComposer): the keys of
 * scripts that are no event, with the aliases of scripts-aliases. undefined when a name or alias would stop Composer
 * (not a command name symfony/console accepts, aliases that are not a list of strings), or the file has none.
 */
export function scriptCommands(manifest: Record<string, unknown>, facts: ComposerScriptCommandsKnowledge): ScriptCommands | undefined {
  const scripts = manifest[facts.scripts];
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return undefined;
  const aliases = manifest[facts.aliases];
  const valid = new RegExp(facts.validName, 'u');
  const events = new Set(facts.events.map((event) => event.toUpperCase().replaceAll('-', '_')));
  const list: { name: string; aliases: string[] }[] = [];
  for (const name of Object.keys(scripts)) {
    if (events.has(name.toUpperCase().replaceAll('-', '_'))) continue;
    // PHP reads a key such as "1" as a number, which Composer does not register as a command name.
    if (/^(?:0|-?[1-9][0-9]*)$/u.test(name)) return undefined;
    if (!valid.test(name)) return undefined;
    const given = typeof aliases === 'object' && aliases !== null && !Array.isArray(aliases) ? (aliases as Record<string, unknown>)[name] : undefined;
    if (given !== undefined && !(Array.isArray(given) && given.every((alias) => typeof alias === 'string' && valid.test(alias)))) return undefined;
    list.push({ name, aliases: (given as string[] | undefined) ?? [] });
  }
  return list.length === 0 ? undefined : { scripts: list };
}

/** Whether a word is a value of PHP's truth: not '' and not '0'. */
function truthy(word: string): boolean {
  return word !== '' && word !== '0';
}

/**
 * The options the binding to the application's input definition sets, as ArgvInput::parse sets them: in order, up to
 * the first word it cannot take (an option the application does not define, a value where none is taken, a missing
 * value, a second argument).
 */
function boundOptions(words: readonly string[], options: readonly ApplicationOption[]): Map<string, string | boolean> {
  const bound = new Map<string, string | boolean>();
  const byName = new Map(options.map((option) => [option.name, option]));
  const byShortcut = new Map(options.flatMap((option) => option.shortcuts.map((shortcut) => [shortcut, option] as const)));
  const negations = new Map(options.filter((option) => option.value === 'negatable').map((option) => [`no-${option.name}`, option]));
  const parsed = [...words];
  let arguments_ = 0;
  let readOptions = true;
  class Stop extends Error {}
  const addLong = (name: string, given: string | null) => {
    const option = byName.get(name);
    if (option === undefined) {
      const negated = negations.get(name);
      if (negated === undefined || given !== null) throw new Stop();
      bound.set(negated.name, false);
      return;
    }
    const accepts = option.value === 'required';
    if (given !== null && !accepts) throw new Stop();
    let value: string | boolean | null = given;
    if ((value === null || value === '') && accepts && parsed.length > 0) {
      const next = parsed.shift() as string;
      if ((next !== '' && !next.startsWith('-')) || next === '') value = next;
      else parsed.unshift(next);
    }
    if (value === null) {
      if (accepts) throw new Stop();
      value = true;
    }
    bound.set(name, value);
  };
  const addShort = (shortcut: string, value: string | null) => {
    const option = byShortcut.get(shortcut);
    if (option === undefined) throw new Stop();
    addLong(option.name, value);
  };
  try {
    while (parsed.length > 0) {
      const word = parsed.shift() as string;
      if (readOptions && word === '') {
        if (arguments_++ > 0) throw new Stop();
      } else if (readOptions && word === '--') {
        readOptions = false;
      } else if (readOptions && word.startsWith('--')) {
        const name = word.slice(2);
        const equals = name.indexOf('=');
        if (equals === -1) addLong(name, null);
        else {
          const value = name.slice(equals + 1);
          if (value === '') parsed.unshift(value);
          addLong(name.slice(0, equals), value);
        }
      } else if (readOptions && word.startsWith('-') && word !== '-') {
        const name = word.slice(1);
        if (name.length > 1) {
          const first = byShortcut.get(name[0] as string);
          if (first !== undefined && first.value === 'required') addShort(name[0] as string, name.slice(1));
          else {
            for (let index = 0; index < name.length; index++) {
              const option = byShortcut.get(name[index] as string);
              if (option === undefined) throw new Stop();
              if (option.value === 'required') {
                addLong(option.name, index === name.length - 1 ? null : name.slice(index + 1));
                break;
              }
              addLong(option.name, null);
            }
          }
        } else addShort(name, null);
      } else if (arguments_++ > 0) {
        throw new Stop();
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return bound;
}

/**
 * The index of the command word among the words after composer, as Composer finds it (getCommandNameBeforeBinding):
 * the words are bound to the options of the application, then ArgvInput::getFirstArgument passes over every word that
 * starts with -, and over the word after one whose bound value it is; -1 when there is none.
 */
export function commandWordIndex(words: readonly string[], options: readonly ApplicationOption[]): number {
  const bound = boundOptions(words, options);
  const shortcuts = new Map(options.flatMap((option) => option.shortcuts.map((shortcut) => [shortcut, option.name] as const)));
  let skip = false;
  for (const [index, word] of words.entries()) {
    if (truthy(word) && word.startsWith('-')) {
      if (word.includes('=') || index === words.length - 1) continue;
      const name = word[1] === '-' ? word.slice(2) : word.slice(-1);
      const key = bound.has(name) ? name : shortcuts.get(name);
      if (key !== undefined && bound.has(key) && words[index + 1] === bound.get(key)) skip = true;
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    return index;
  }
  return -1;
}
