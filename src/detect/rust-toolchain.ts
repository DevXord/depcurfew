// The Rust version a repository pins for Cargo in rust-toolchain or rust-toolchain.toml (E06), read as rustup reads the
// files (extra.toolchainFiles and extra.toolchainChannels of Cargo): when both are in a directory rustup uses
// rust-toolchain; rust-toolchain.toml is TOML only ([toolchain] channel), rust-toolchain also a bare channel name.
import { isRecord, values } from '../apply/facts.ts';
import { cargo } from '../knowledge/cargo.ts';
import type { Repository } from './repository.ts';
import { parseToml, type TomlDocument } from './toml.ts';
import type { VersionDeclaration } from './types.ts';

interface ToolchainFacts {
  files: string[];
  bothUse: string;
  legacyIn: string;
}

function toolchainFacts(): ToolchainFacts | undefined {
  const fact = cargo.extra?.['toolchainFiles'];
  const found = fact === undefined ? undefined : values(fact)[0];
  if (!isRecord(found) || !Array.isArray(found['files']) || typeof found['bothUse'] !== 'string' || typeof found['legacyIn'] !== 'string') return undefined;
  return { files: found['files'].filter((file): file is string => typeof file === 'string'), bothUse: found['bothUse'], legacyIn: found['legacyIn'] };
}

function latestRust(): string | undefined {
  const fact = cargo.extra?.['latestVersion'];
  const found = fact === undefined ? undefined : values(fact)[0];
  return typeof found === 'string' ? found : undefined;
}

const isDigits = (text: string): boolean => text !== '' && [...text].every((character) => character >= '0' && character <= '9');

/**
 * The version a rustup channel stands for: X.Y.Z (also with -<host> after it) is that release, X.Y the latest X.Y.z
 * (kept as written), X.Y.Z-beta.N that pre-release, stable the latest Rust the knowledge base knows (with the channel
 * kept), and anything else (beta, nightly, a date, a custom toolchain) a version depcurfew cannot read, with the reason.
 */
function channelVersion(channel: string): Pick<VersionDeclaration & { version: string }, 'version' | 'unknown' | 'channel'> {
  const parts = channel.split('-');
  const numbers = (parts[0] ?? '').split('.');
  if ((numbers.length === 2 || numbers.length === 3) && numbers.every(isDigits)) {
    const version = parts[0] ?? channel;
    const beta = parts[1]?.startsWith('beta') === true ? `${version}-${parts[1]}` : undefined;
    if (beta !== undefined) return { version: beta };
    return parts.length > 1 ? { version, channel } : { version };
  }
  if (channel === 'stable') {
    const latest = latestRust();
    return latest === undefined ? { version: channel, unknown: 'the knowledge base knows no Rust release' } : { version: latest, channel };
  }
  const named = parts[0] ?? '';
  if (named === 'beta' || named === 'nightly' || named === 'stable') return { version: channel, unknown: `the rustup channel ${channel} names no Rust release` };
  return { version: channel, unknown: `${channel} is a custom rustup toolchain, whose Rust version depcurfew cannot tell` };
}

/** The channel of a toolchain file and its line: TOML [toolchain] channel, or (legacy) the first line of rust-toolchain. */
function readChannel(text: string, legacy: boolean): { channel: string; line: number } | { notToml: string; line: number } | undefined {
  let document: TomlDocument | undefined;
  try {
    document = parseToml(text);
  } catch {
    document = undefined;
  }
  const table = document?.root['toolchain'];
  if (document !== undefined && isRecord(table)) {
    const channel = table['channel'];
    return typeof channel === 'string' ? { channel, line: document.lineOf(['toolchain', 'channel']) ?? 1 } : undefined;
  }
  const first = text.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim();
  if (first === undefined) return undefined;
  return legacy ? { channel: first, line: text.split(/\r?\n/u).findIndex((line) => line.trim() !== '') + 1 } : { notToml: first, line: 1 };
}

/** The Rust version the toolchain file of the directory `directory` ('.' for the root) pins, if it names one. */
export function rustToolchainVersion(repository: Repository, directory: string): VersionDeclaration | undefined {
  const facts = toolchainFacts();
  if (facts === undefined) return undefined;
  const path = (file: string) => (directory === '.' ? file : `${directory}/${file}`);
  const present = facts.files.filter((file) => repository.isFile(path(file)));
  const chosen = present.length > 1 ? facts.bothUse : present[0];
  if (chosen === undefined) return undefined;
  const file = path(chosen);
  const text = repository.readText(file);
  if (text === undefined) return undefined;
  const read = readChannel(text, chosen === facts.legacyIn);
  if (read === undefined) return undefined;
  if ('notToml' in read) {
    return { version: read.notToml, source: 'tool-config', file, line: read.line, unknown: `rustup reads ${chosen} as TOML only, and this one is not TOML with [toolchain] channel` };
  }
  return { ...channelVersion(read.channel), source: 'tool-config', file, line: read.line };
}
