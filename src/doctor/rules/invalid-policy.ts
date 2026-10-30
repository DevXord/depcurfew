// invalid-policy: depcurfew.json that does not follow the schema or cannot be read. doctor then runs only the rules
// that need no policy, as without a policy file, and reports the problems like any other finding, so the text, JSON
// and SARIF output say the same. runDoctor reports it only when asked to (the CLI does); otherwise it throws.
import { loadPolicyIfPresent, PolicyError } from '../../apply/index.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { Rule } from '../types.ts';

const FIXES: Readonly<Partial<Record<PolicyError['code'], string>>> = {
  'policy-invalid': `Fix these problems in ${POLICY_FILE}; an editor that reads its $schema shows them as you type`,
  'policy-unreadable': `Make ${POLICY_FILE} a regular file inside the repository, so that depcurfew can read it`,
};

export const invalidPolicy: Rule = {
  id: 'invalid-policy',
  summary: `${POLICY_FILE} does not follow the schema or cannot be read.`,
  description: `Without a valid policy, the rules that compare the repository with ${POLICY_FILE} cannot run, so doctor runs only the rules that need no policy, as when there is no policy file.`,
  help: `Fix what the message lists; an editor that reads the $schema of ${POLICY_FILE} shows the problems as you type.`,
  level: 'error',
  requiresPolicy: false,
  check(context) {
    try {
      loadPolicyIfPresent(context.root);
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      context.report({
        location: { file: POLICY_FILE },
        message: error.issues.length === 0 ? error.text : `${error.text}: ${error.issues.join('; ')}`,
        fix: FIXES[error.code] ?? error.fix ?? invalidPolicy.help,
      });
    }
  },
};
