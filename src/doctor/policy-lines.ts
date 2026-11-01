// The line of depcurfew.json a problem of the policy concerns (decision D-116): validation names a field by its path
// (cooldown.minimum, projects[4], installScripts["allow"]), and the line is that of the field in the text, or of the
// nearest field around it that is there. A JSON syntax error names its line itself. Without either, there is none.
import type { PolicyIssue } from '../policy/validate.ts';
import { positionInMessage } from './positions.ts';
import { jsonSetting } from './settings.ts';

/** A path as formatPath writes it, as segments; undefined for "(root)" and anything it does not write. */
export function parseIssuePath(path: string): (string | number)[] | undefined {
  if (path === '(root)') return [];
  const segments: (string | number)[] = [];
  const pattern = /^(?:\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/u;
  let rest = path;
  while (rest !== '') {
    const match = pattern.exec(rest);
    if (match === null) return undefined;
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(Number(match[2]));
    else segments.push(JSON.parse(match[3] ?? '""') as string);
    rest = rest.slice(match[0].length);
  }
  return segments;
}

/** The line of the first issue that has one: the field it names, or the nearest field around it, or a syntax error's own. */
export function policyIssueLine(text: string, issues: readonly PolicyIssue[]): number | undefined {
  for (const issue of issues) {
    const segments = parseIssuePath(issue.path);
    if (segments === undefined) continue;
    if (segments.length === 0) {
      const position = positionInMessage(issue.message);
      if (position !== undefined) return position.line;
      continue;
    }
    for (let length = segments.length; length > 0; length--) {
      const found = jsonSetting(text, segments.slice(0, length));
      if (found !== undefined) return found.line;
    }
  }
  return undefined;
}
