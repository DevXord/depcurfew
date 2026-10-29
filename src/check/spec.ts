// Package specs as given to an install command: a registry name with an optional version, range or tag (also behind
// an npm: alias), a git repository, a tarball URL, a local path or a workspace package. Only registry specs can be
// looked up; the other sources are checked against the policy's sources section without network access. The forms
// come from the package managers' packageSpecs facts; a spec with any other protocol is not looked up.
import { values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { PackageSpecKnowledge } from '../knowledge/types.ts';

export type SpecKind = 'registry' | 'git' | 'remoteTarball' | 'file' | 'directory' | 'workspace' | 'other';

export interface PackageSpec {
  raw: string;
  kind: SpecKind;
  /** registry: the package to look up (the target of an npm: alias). */
  name?: string;
  /** registry: a version, range or tag; empty for the default tag. */
  selector?: string;
  /** remoteTarball: a URL without a tarball extension, which a package manager may read as a git repository. */
  maybeGit?: boolean;
  /** other: why the spec is not looked up. */
  reason?: string;
}

interface SpecForms {
  git: string[];
  local: string[];
  workspace: string[];
  aliases: string[];
  remoteTarball: string[];
  tarballExtensions: string[];
  shorthand: boolean;
  scp: boolean;
}

let cached: SpecForms | undefined;

/** The spec forms of every package manager together. */
function forms(): SpecForms {
  if (cached !== undefined) return cached;
  const all = knowledgeBase.flatMap((tool) => {
    const fact = tool.extra?.['packageSpecs'];
    return fact === undefined ? [] : (values(fact) as PackageSpecKnowledge[]);
  });
  const union = (pick: (forms: PackageSpecKnowledge) => readonly string[] | string | undefined) => [...new Set(all.flatMap((forms) => pick(forms) ?? []))];
  cached = {
    git: union((forms) => forms.git),
    local: union((forms) => forms.local),
    workspace: union((forms) => forms.workspace),
    aliases: union((forms) => forms.alias),
    remoteTarball: union((forms) => forms.remoteTarball),
    tarballExtensions: union((forms) => forms.tarballExtensions),
    shorthand: all.some((forms) => forms.shorthand !== undefined),
    scp: all.some((forms) => forms.scp === true),
  };
  return cached;
}

const NAME = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/u;
/** user/repo, optionally with #commit-ish. */
const SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(?:#.*)?$/u;
/** ./, ../, /, ~/ and Windows drive paths; ~ alone is the home directory, which the shell expands at the start of a word. */
const PATH = /^(?:\.{1,2}(?:[/\\]|$)|[/\\]|~(?:[/\\]|$)|[A-Za-z]:[/\\])/u;
/** The same after name@, where ~ and ~1.2.3 are ranges. */
const PATH_AFTER_NAME = /^(?:\.{1,2}(?:[/\\]|$)|[/\\]|~[/\\]|[A-Za-z]:[/\\])/u;
/** user@host:path with a dotted host, the scp-like form of an ssh URL; git@1.0.0 is the package git. */
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:[^\s]+$/u;
/** A URL scheme or package manager protocol such as jsr: or patch:. */
const PROTOCOL = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function prefixOf(text: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find((prefix) => text.startsWith(prefix));
}

function isTarball(path: string): boolean {
  return forms().tarballExtensions.some((extension) => path.endsWith(extension));
}

/** Classifies what follows the name, or a whole spec without a name. */
function source(raw: string, text: string, afterName: boolean): PackageSpec | undefined {
  const known = forms();
  if (prefixOf(text, known.workspace) !== undefined) return { raw, kind: 'workspace' };
  if (prefixOf(text, known.git) !== undefined) return { raw, kind: 'git' };
  if (prefixOf(text, known.remoteTarball) !== undefined) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    return isTarball(url.pathname) ? { raw, kind: 'remoteTarball' } : { raw, kind: 'remoteTarball', maybeGit: true };
  }
  if (prefixOf(text, known.local) !== undefined || (afterName ? PATH_AFTER_NAME : PATH).test(text)) return { raw, kind: isTarball(text) ? 'file' : 'directory' };
  const protocol = PROTOCOL.exec(text)?.[0];
  if (protocol !== undefined) return { raw, kind: 'other', reason: `it uses the ${protocol} protocol, which depcurfew does not look up` };
  return undefined;
}

/** name@selector, where the name may be scoped. */
function splitName(text: string): { name: string; rest: string | undefined } {
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  return at <= 0 ? { name: text, rest: undefined } : { name: text.slice(0, at), rest: text.slice(at + 1) };
}

function registry(raw: string, text: string): PackageSpec | undefined {
  const { name, rest } = splitName(text);
  if (!NAME.test(name)) return undefined;
  if (rest === undefined) return { raw, kind: 'registry', name, selector: '' };
  const alias = prefixOf(rest, forms().aliases);
  if (alias !== undefined) return registry(raw, rest.slice(alias.length));
  const other = source(raw, rest, true);
  if (other !== undefined) return other;
  if ((forms().shorthand && SHORTHAND.test(rest)) || (forms().scp && SCP.test(rest))) return { raw, kind: 'git' };
  return /^[^\s/\\]*$/u.test(rest) ? { raw, kind: 'registry', name, selector: rest } : undefined;
}

/** undefined when the text is not a package spec. */
export function parseSpec(raw: string): PackageSpec | undefined {
  const text = raw.trim();
  if (text === '' || /\s/u.test(text)) return undefined;
  const alias = prefixOf(text, forms().aliases);
  if (alias !== undefined) return registry(raw, text.slice(alias.length));
  const other = source(raw, text, false);
  if (other !== undefined) return other;
  if (forms().scp && SCP.test(text)) return { raw, kind: 'git' };
  if (!text.startsWith('@') && forms().shorthand && SHORTHAND.test(text)) return { raw, kind: 'git' };
  return registry(raw, text);
}
