// Settings a tool version is too old for, in one readable phrase: "min-release-age and allow-git (since 11.10.0),
// allowScripts (since 11.16.0)". Settings that arrived in the same version are listed together.
import { compareVersions, parseVersion } from './version.ts';

export interface Requirement {
  setting: string;
  since: string;
  /** Official sources disagree on the version; the later one is assumed. */
  disputed?: boolean;
}

/** "a", "a and b", "a, b and c". */
export function listing(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

export function describeRequirements(requirements: readonly Requirement[]): string {
  const groups = new Map<string, { settings: string[]; disputed: boolean }>();
  for (const { setting, since, disputed } of requirements) {
    const group = groups.get(since) ?? { settings: [], disputed: false };
    if (!group.settings.includes(setting)) group.settings.push(setting);
    group.disputed ||= disputed === true;
    groups.set(since, group);
  }
  const order = (a: string, b: string) => compareVersions(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0]);
  const text = [...groups.entries()]
    .sort(([a], [b]) => order(a, b))
    .map(([since, group]) => `${listing(group.settings)} (since ${since})`)
    .join(', ');
  const disputed = [...groups.values()].some((group) => group.disputed);
  return disputed ? `${text}; where official sources disagree on the version, depcurfew assumes the later one` : text;
}
