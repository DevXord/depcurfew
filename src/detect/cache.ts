// One detection per directory for a command that describes the same repository several times (decision D-157): doctor
// without depcurfew.json detects the root for the policy depcurfew init would write (decision D-149), for the locked
// versions of known-malicious (decision D-150) and in both runs of the rules, and every project for that policy and
// for the rules. The files do not change during one command, so the shared detection is the one detecting again would
// give; nothing changes a detection after it is made.
import { resolve } from 'node:path';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { detectProject, type DetectOptions } from './index.ts';
import type { Detection } from './types.ts';

export class Detections {
  readonly #byTools = new Map<readonly ToolKnowledge[], Map<string, Detection>>();

  /** detectProject(root, tools, undefined, options), the first time for this directory, these tools and these projects. */
  detect(root: string, tools: readonly ToolKnowledge[] = knowledgeBase, options: DetectOptions = {}): Detection {
    let detections = this.#byTools.get(tools);
    if (detections === undefined) {
      detections = new Map();
      this.#byTools.set(tools, detections);
    }
    const key = JSON.stringify([resolve(root), options.projects ?? []]);
    let detection = detections.get(key);
    if (detection === undefined) {
      detection = detectProject(root, tools, undefined, options);
      detections.set(key, detection);
    }
    return detection;
  }
}
