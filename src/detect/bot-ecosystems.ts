// Ecosystems whose new versions depcurfew delays only through the update bots (decision D-151): Cargo, Go modules,
// Maven, Gradle and NuGet. Their package managers have no release-age delay depcurfew configures, so detection only
// notes their files; apply gives the Dependabot entries of these ecosystems the cooldown, and doctor compares the bots'
// delay for them with cooldown.minimum. The file names come from the knowledge base (environment.botOnlyEcosystems).
import { evidenceOf } from '../knowledge/facts.ts';
import { environment as environmentKnowledge } from '../knowledge/environment.ts';
import type { BotOnlyEcosystemId, BotOnlyProjectKnowledge, ClientDelayKnowledge, EnvironmentKnowledge } from '../knowledge/types.ts';
import { joinPath, type Repository } from './repository.ts';
import type { BotEcosystemInfo } from './types.ts';

export interface BotEcosystemFacts extends BotOnlyProjectKnowledge {
  id: BotOnlyEcosystemId;
  delay: ClientDelayKnowledge;
}

/** The ecosystems of the knowledge base, in its order; for a disputed fact the first variant. */
export function botEcosystemFacts(environment: EnvironmentKnowledge = environmentKnowledge): BotEcosystemFacts[] {
  return (Object.entries(environment.botOnlyEcosystems) as [BotOnlyEcosystemId, EnvironmentKnowledge['botOnlyEcosystems'][BotOnlyEcosystemId]][]).flatMap(([id, entry]) => {
    const project = evidenceOf(entry.project)[0]?.value;
    const delay = evidenceOf(entry.releaseAge)[0]?.value;
    return project === undefined || delay === undefined ? [] : [{ id, ...project, delay }];
  });
}

export function botEcosystemFact(id: BotOnlyEcosystemId, environment: EnvironmentKnowledge = environmentKnowledge): BotEcosystemFacts | undefined {
  return botEcosystemFacts(environment).find((entry) => entry.id === id);
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The ecosystems whose files are in the directories (the root, its direct subdirectories that are not hidden, workspace
 * packages and the directories listed in projects), with the files found, in the order of the knowledge base.
 */
export function detectBotEcosystems(repository: Repository, facts: readonly BotEcosystemFacts[], directories: readonly string[]): BotEcosystemInfo[] {
  const listed = new Map<string, string[]>();
  const filesIn = (directory: string) => {
    let names = listed.get(directory);
    if (names === undefined) {
      names = repository.listFiles(directory);
      listed.set(directory, names);
    }
    return names;
  };
  return facts.flatMap((ecosystem): BotEcosystemInfo[] => {
    const found = new Set<string>();
    for (const directory of directories) {
      for (const file of ecosystem.files) {
        const path = joinPath(directory, file);
        if (repository.isFile(path)) found.add(path);
      }
      const extensions = ecosystem.extensions ?? [];
      if (extensions.length === 0) continue;
      for (const name of filesIn(directory)) {
        if (extensions.some((extension) => name.length > extension.length && name.endsWith(extension))) found.add(joinPath(directory, name));
      }
    }
    return found.size === 0 ? [] : [{ id: ecosystem.id, files: [...found].sort(byPath) }];
  });
}

/**
 * What the package manager itself does about new versions, for messages: "Go has no release-age delay of its own".
 * With `details`, a setting it has from some version on is named, with what it covers and that depcurfew does not
 * configure it.
 */
export function ownDelayText(ecosystem: BotEcosystemFacts, details: boolean): string {
  const { client, delay } = ecosystem;
  if (delay.setting === null || delay.since === null) return `${client} has no release-age delay of its own`;
  const version = `${delay.product === undefined ? '' : `${delay.product} `}${delay.since}`;
  const where = delay.file === undefined ? delay.setting : `${delay.setting} in ${delay.file}`;
  if (delay.updatesOnly === true) {
    const short = `${client} has no release-age delay for what an install or restore takes`;
    return details ? `${short} (${where}, from ${version} on, holds back only the versions an update picks, and depcurfew does not configure it)` : short;
  }
  const short = `${client} before ${delay.since} has no release-age delay of its own`;
  return details ? `${short} (${version} adds ${where}, which depcurfew does not configure)` : short;
}
