// invalid-project: a directory listed in projects in depcurfew.json that cannot be used (decision D-100). doctor
// then checks the root and the other projects, and depcurfew apply writes nothing; the messages and fixes are the
// ones apply reports, from projectProblems.
import { projectProblems } from '../../apply/projects.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { Rule } from '../types.ts';

export const invalidProject: Rule = {
  id: 'invalid-project',
  checks: `Every directory listed in projects in ${POLICY_FILE} exists in the repository, has no ${POLICY_FILE} of its own and is not a workspace package of the root`,
  summary: `A directory listed in projects in ${POLICY_FILE} does not exist, is not a directory, is a symlink, has a ${POLICY_FILE} of its own or overlaps a workspace package of the root.`,
  description: `depcurfew checks and configures each listed directory as a project of its own. A directory that is missing or misspelled is never checked, so its package managers keep whatever configuration they have; one with a ${POLICY_FILE} of its own would follow two policies, and a workspace package of the root is configured with the root already. depcurfew apply writes nothing while one of them is listed.`,
  help: `Correct or remove the entry in projects, or remove the ${POLICY_FILE} of the project.`,
  level: 'error',
  requiresPolicy: true,
  // Only a policy that lists projects has any to check (decision D-098).
  applies: (scope) => (scope.policy?.projects.length ?? 0) > 0,
  check(context) {
    // Projects are listed in the depcurfew.json of the root only.
    if (context.project !== undefined || context.policy === undefined) return;
    for (const problem of projectProblems(context.root, context.policy.projects, context.detection)) {
      context.report({ location: problem.location, message: problem.message, fix: problem.fix });
    }
  },
};
