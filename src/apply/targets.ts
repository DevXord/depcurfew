// targets "auto": the tools the repository shows it uses. A package manager seen only in a CI setup step, with no
// manifest, lockfile or configuration of its own in the repository, installs nothing from it (denoland/std sets up Bun
// in CI but has no package.json), so it is left out rather than given new files (decision D-075). One the root's CI sets
// up only for the projects (ciForProjects, decision D-137) is no target of the root either, and without a manifest of
// its own in the root it is in ciOnly, so that apply names it in tool-only-in-ci as before.
import { detectedTargets } from '../cli/describe.ts';
import { Repository } from '../detect/repository.ts';
import type { Detection } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { values } from './facts.ts';

export interface AutoTargets {
  targets: ToolId[];
  /** Package managers seen only in CI, with the workflows that set them up. */
  ciOnly: { id: ToolId; workflows: string[]; manifests: string[] }[];
}

/** The project manifests of a tool (package.json, deno.json, pyproject.toml, Pipfile, requirements.txt …). */
export function manifestsOf(tool: ToolKnowledge): string[] {
  return tool.project === undefined ? [] : [...new Set(values(tool.project.manifests).flat())];
}

export function autoTargets(root: string, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): AutoTargets {
  const repository = new Repository(root);
  const ciOnly: AutoTargets['ciOnly'] = [];
  for (const manager of [...detection.packageManagers, ...(detection.ciForProjects ?? [])]) {
    const tool = tools.find((entry) => entry.id === manager.id);
    if (!manager.supported || tool === undefined || !manager.evidence.every((item) => item.kind === 'ci')) continue;
    const manifests = manifestsOf(tool);
    if (manifests.some((file) => repository.isFile(file))) continue;
    ciOnly.push({ id: manager.id, workflows: manager.evidence.map((item) => item.file), manifests });
  }
  return { targets: detectedTargets(detection).filter((id) => !ciOnly.some((entry) => entry.id === id)), ciOnly };
}

/**
 * Whether the policy's release-age delay covers the actions the workflows run for a bot (decision D-130): the
 * repository has workflows, and the policy has a cooldown and configures the bot (targets "auto" or naming it).
 */
export function coversActions(policy: ResolvedPolicy | undefined, bot: ToolId, detection: Pick<Detection, 'workflows'>): boolean {
  return policy?.cooldown !== undefined && (policy.targets === 'auto' || policy.targets.includes(bot)) && detection.workflows.length > 0;
}

/**
 * Whether the policy's release-age delay covers the ecosystems updated by bots only for a bot (decision D-151): the
 * policy has a cooldown and configures the bot. apply writes it into every Dependabot entry of these ecosystems; doctor
 * compares the bot's delay for them with cooldown.minimum.
 */
export function coversBotEcosystems(policy: ResolvedPolicy | undefined, bot: ToolId): boolean {
  return policy?.cooldown !== undefined && (policy.targets === 'auto' || policy.targets.includes(bot));
}

/**
 * The tools apply configures in one directory. Without projects: the detected ones ("auto") or the listed ones. With
 * projects (decision D-100), listed package managers only where they are detected, as npm in a Python project would
 * get an .npmrc it never reads; Renovate and Dependabot read their configuration from the repository root only, so a
 * project (`project` set) configures none.
 */
export function directoryTargets(
  root: string,
  policy: ResolvedPolicy,
  detection: Detection,
  tools: readonly ToolKnowledge[],
  place: { project?: string; withProjects: boolean },
): { targets: Set<ToolId>; auto: AutoTargets | undefined } {
  const auto = policy.targets === 'auto' ? autoTargets(root, detection, tools) : undefined;
  const isBot = (id: ToolId) => tools.find((tool) => tool.id === id)?.kind === 'update-bot';
  let targets: Set<ToolId>;
  if (policy.targets === 'auto') targets = new Set(auto?.targets ?? []);
  else if (place.withProjects) {
    const found = new Set(autoTargets(root, detection, tools).targets);
    targets = new Set(policy.targets.filter((id) => isBot(id) || found.has(id)));
  } else targets = new Set(policy.targets);
  if (place.project !== undefined) for (const id of [...targets]) if (isBot(id)) targets.delete(id);
  return { targets, auto };
}
