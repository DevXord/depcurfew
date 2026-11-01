// The part of depcurfew explain's output that says what the policy means for each tool (decision D-117), as
// tests/fixtures/expected/<name>/explain.json and explain.txt hold it: the policy section, and for each directory
// listed in projects its targets and what apply does with installScripts and sources there. What detection found is
// left out; tests/fixtures/expected/<name>/detect.json covers it.

interface ExplainDocument {
  policy: unknown;
  projects: { directory: string; targets?: unknown; installScripts?: unknown; sources?: unknown; error?: unknown }[];
}

export interface ExplainExpectation {
  json: { policy: unknown; projects: unknown[] };
  text: string;
}

/** The policy lines of the text: the policy section, and each project's heading and the lines from its targets on. */
function policyText(text: string): string {
  const kept: string[] = [];
  let section: 'detection' | 'policy' | 'project' | 'project-policy' = 'detection';
  for (const line of text.split('\n')) {
    if (line.startsWith('Policy')) section = 'policy';
    else if (line.startsWith('Project ')) {
      section = 'project';
      kept.push('', line);
      continue;
    } else if (section === 'project' && line.startsWith('  targets:')) section = 'project-policy';
    else if (line === '') {
      if (section === 'policy') section = 'detection';
      continue;
    }
    if (section === 'policy' || section === 'project-policy') kept.push(line);
  }
  return `${kept.join('\n')}\n`;
}

export function explainExpectation(document: ExplainDocument, text: string): ExplainExpectation {
  return {
    json: {
      policy: document.policy,
      projects: document.projects.map((entry) =>
        entry.error === undefined
          ? { directory: entry.directory, targets: entry.targets, installScripts: entry.installScripts, sources: entry.sources }
          : { directory: entry.directory, error: entry.error },
      ),
    },
    text: policyText(text),
  };
}
