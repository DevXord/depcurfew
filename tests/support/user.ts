// Helpers for the --user tests: they run on the real file system of the machine, so paths follow its platform and
// the expected user files are worked out from the knowledge base the way apply --user finds them.
import type { Version } from '../../src/apply/version.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import { shownPath, userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';

/** The platform these tests run on, for environments that point at real temporary directories. */
export const platform = process.platform;

/** A tool's user file as apply --user shows it (~/.config/uv/uv.toml on Linux, ~/AppData/Roaming/uv/uv.toml on Windows). */
export function shownUserFile(id: ToolId, environment: UserEnvironment, version?: Version): string {
  const tool = knowledgeBase.find((candidate) => candidate.id === id);
  const file = tool === undefined ? null : userFileFor(tool, version);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (path === undefined) throw new Error(`no user file for ${id}`);
  return shownPath(path, environment);
}

/** The user policy as messages show it. */
export function shownPolicy(environment: UserEnvironment): string {
  return shownPath(userPolicyPath(environment), environment);
}
