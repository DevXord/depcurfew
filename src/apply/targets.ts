// targets "auto": the tools the repository shows it uses. A package manager seen only in a CI setup step, with no
// manifest, lockfile or configuration of its own in the repository, installs nothing from it (denoland/std sets up Bun
// in CI but has no package.json), so it is left out rather than given new files (decision D-075).
import { detectedTargets } from '../cli/describe.ts';
import { Repository } from '../detect/repository.ts';
import type { Detection } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
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
  for (const manager of detection.packageManagers) {
    const tool = tools.find((entry) => entry.id === manager.id);
    if (!manager.supported || tool === undefined || !manager.evidence.every((item) => item.kind === 'ci')) continue;
    const manifests = manifestsOf(tool);
    if (manifests.some((file) => repository.isFile(file))) continue;
    ciOnly.push({ id: manager.id, workflows: manager.evidence.map((item) => item.file), manifests });
  }
  return { targets: detectedTargets(detection).filter((id) => !ciOnly.some((entry) => entry.id === id)), ciOnly };
}
