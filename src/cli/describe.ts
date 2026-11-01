// Display names and the policy targets of a detected repository, shared by init and explain.
import type { Detection, PackageManagerInfo } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId } from '../knowledge/types.ts';

export function toolName(id: ToolId): string {
  return knowledgeBase.find((tool) => tool.id === id)?.name ?? id;
}

export function managerName(manager: PackageManagerInfo): string {
  return manager.variant === 'classic' ? 'Yarn Classic (not supported)' : toolName(manager.id);
}

/** Tools that `targets: "auto"` resolves to: supported package managers, then bots. */
export function detectedTargets(detection: Detection): ToolId[] {
  return [
    ...detection.packageManagers.filter((manager) => manager.supported).map((manager) => manager.id),
    ...detection.bots.map((bot) => bot.id),
  ];
}
