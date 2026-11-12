// Room for longer rule texts in SARIF (E03). GitHub code scanning limits shortDescription.text and fullDescription.text
// to 1024 characters and shows help.markdown instead of help.text when a rule has it (environment.githubActions
// .sarifRules). doctor cuts a longer summary or description at the end of a sentence within the limit, and gives the
// whole description, "Fix:" and the help in help.markdown; help.text stays the help.
import { describe, expect, it } from 'vitest';
import { values } from '../../src/apply/facts.ts';
import { RULES, toSarif, type DoctorReport, type Rule } from '../../src/doctor/index.ts';
import { withinLimit } from '../../src/doctor/sarif.ts';
import { environment } from '../../src/knowledge/environment.ts';

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown?: string };
}

const EMPTY: DoctorReport = { schemaVersion: 1, policy: 'valid', findings: [], notices: [], warnings: [] } as unknown as DoctorReport;

function driverRules(rules: readonly Rule[]): SarifRule[] {
  const sarif = toSarif(EMPTY, rules, '0.0.0') as { runs: { tool: { driver: { rules: SarifRule[] } } }[] };
  return sarif.runs[0]?.tool.driver.rules ?? [];
}

const sentence = (index: number) => `Sentence number ${index} says something about the rule and why it matters.`;
const LONG = Array.from({ length: 40 }, (_, index) => sentence(index + 1)).join(' ');
const rule: Rule = { ...(RULES[0] as Rule), id: 'long-rule', summary: 'Finds a long thing.', description: LONG, help: 'Run `depcurfew apply` and commit *every* file it changes.' };

describe('the SARIF limits of GitHub code scanning (E03)', () => {
  it('are facts with a pinned source', () => {
    const fact = environment.githubActions.sarifRules;
    expect(values(fact)[0]).toEqual({ descriptionLimit: 1024, helpMarkdown: true });
    if (fact.status !== 'verified') throw new Error('the fact is not verified');
    expect(fact.source).toMatch(/^https:\/\/github\.com\/github\/docs\/blob\/[0-9a-f]{40}\/content\/code-security\/reference\/code-scanning\/sarif-files\/sarif-support\.md#L156-L160$/u);
  });

  it('cut a long description at the end of the last sentence that fits', () => {
    expect(LONG.length).toBeGreaterThan(2000);
    const [sarif] = driverRules([rule]);
    const text = sarif?.fullDescription.text ?? '';
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text.length).toBeGreaterThan(1024 - sentence(40).length - 1);
    expect(LONG.startsWith(text)).toBe(true);
    expect(text.endsWith('matters.')).toBe(true);
  });

  it('give the whole description, Fix: and the help in help.markdown, and the help in help.text', () => {
    const [sarif] = driverRules([rule]);
    expect(sarif?.help.text).toBe(rule.help);
    expect(sarif?.help.markdown).toBe(`${LONG}\n\n**Fix:** Run \`depcurfew apply\` and commit \\*every\\* file it changes.`);
  });

  it('leave a text within the limit as it is, and cut one without a sentence end at a word', () => {
    expect(withinLimit('Short. Text.', 1024)).toBe('Short. Text.');
    const words = 'word '.repeat(300).trim();
    const cut = withinLimit(words, 1024);
    expect(cut.length).toBeLessThanOrEqual(1024);
    expect(cut.endsWith('...')).toBe(true);
    expect(words.startsWith(cut.slice(0, -3))).toBe(true);
    expect(withinLimit('x'.repeat(2000), 1024)).toBe(`${'x'.repeat(1021)}...`);
    // A full stop inside a word (a file name, a version) is no sentence end.
    expect(withinLimit(`See depcurfew.json ${'and more '.repeat(200)}`, 30)).toBe('See depcurfew.json and more...');
  });

  it('hold for every rule of doctor', () => {
    for (const sarif of driverRules(RULES)) {
      const source = RULES.find((item) => item.id === sarif.id) as Rule;
      expect(sarif.shortDescription.text.length, sarif.id).toBeLessThanOrEqual(1024);
      expect(sarif.fullDescription.text.length, sarif.id).toBeLessThanOrEqual(1024);
      expect(sarif.help.text, sarif.id).toBe(source.help);
      expect(sarif.help.markdown, sarif.id).toContain('**Fix:** ');
    }
  });
});
