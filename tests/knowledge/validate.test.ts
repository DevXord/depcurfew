import { describe, expect, it } from 'vitest';
import { validateKnowledge } from '../../src/knowledge/validate.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';
import { buildTool, deletePath, getPath, setPath, TODAY, verified } from './builders.ts';

const PATH = 'cooldown.setting';

function issuesFor(tool: ToolKnowledge, path = PATH): string[] {
  return validateKnowledge([tool], TODAY)
    .filter((issue) => issue.path === path)
    .map((issue) => issue.message);
}

function withFact(fact: unknown, path = PATH): ToolKnowledge {
  const tool = buildTool();
  setPath(tool as unknown as Record<string, unknown>, path, fact);
  return tool;
}

describe('validateKnowledge', () => {
  it('accepts a complete, well-formed entry', () => {
    expect(validateKnowledge([buildTool('npm'), buildTool('renovate', 'update-bot')], TODAY)).toEqual([]);
  });

  describe('sources', () => {
    it('rejects a fact without a source', () => {
      const tool = buildTool();
      deletePath(tool, `${PATH}.source`);
      expect(issuesFor(tool)).toEqual([expect.stringMatching(/missing source/)]);
    });

    it.each([[''], ['   ']])('rejects an empty source %j', (source) => {
      expect(issuesFor(withFact(verified('x', source)))).toEqual([expect.stringMatching(/missing source/)]);
    });

    it('rejects a source that is not a URL', () => {
      expect(issuesFor(withFact(verified('x', 'docs.npmjs.com/cli')))).toEqual([
        expect.stringMatching(/not a valid URL/),
      ]);
    });

    it('rejects a plain http source', () => {
      expect(issuesFor(withFact(verified('x', 'http://docs.npmjs.com/cli')))).toEqual([
        expect.stringMatching(/must use https/),
      ]);
    });

    it.each([
      ['a third-party blog', 'https://socket.dev/blog/npm-min-release-age'],
      ['a GitHub repository outside the tool organisation', 'https://github.com/someone/npm-fork/releases'],
      ["another tool's documentation", 'https://pnpm.io/settings'],
    ])('rejects %s', (_name, source) => {
      expect(issuesFor(withFact(verified('x', source)))).toEqual([expect.stringMatching(/not an official/)]);
    });

    it('accepts official GitHub and changelog locations', () => {
      for (const source of [
        'https://github.com/npm/cli/releases/tag/v11.10.0',
        'https://github.blog/changelog/2025-01-01-npm-example/',
      ]) {
        expect(issuesFor(withFact(verified('x', source)))).toEqual([]);
      }
    });
  });

  describe('verification date', () => {
    it.each([['28.10.2026'], ['2026-02-30'], ['2026-10-28T10:00:00Z'], ['']])('rejects %j', (verifiedAt) => {
      expect(issuesFor(withFact(verified('x', 'https://docs.npmjs.com/cli', verifiedAt)))).toEqual([
        expect.stringMatching(/verifiedAt must be a YYYY-MM-DD date/),
      ]);
    });

    it('rejects a missing date', () => {
      const tool = buildTool();
      deletePath(tool, `${PATH}.verifiedAt`);
      expect(issuesFor(tool)).toEqual([expect.stringMatching(/verifiedAt must be a YYYY-MM-DD date/)]);
    });

    it('rejects a date in the future', () => {
      expect(issuesFor(withFact(verified('x', 'https://docs.npmjs.com/cli', '2026-10-29')))).toEqual([
        expect.stringMatching(/in the future/),
      ]);
    });
  });

  describe('statuses', () => {
    const evidence = (value: unknown) => ({ value, source: 'https://docs.npmjs.com/cli', verifiedAt: TODAY });

    it('rejects an uncertain fact without a note', () => {
      expect(issuesFor(withFact({ status: 'uncertain', ...evidence('x') }))).toEqual([
        expect.stringMatching(/needs a note/),
      ]);
    });

    it('accepts an uncertain fact with a note', () => {
      expect(issuesFor(withFact({ status: 'uncertain', note: 'only in changelog', ...evidence('x') }))).toEqual([]);
    });

    it('rejects a disputed fact with a single variant', () => {
      expect(issuesFor(withFact({ status: 'disputed', note: 'n', variants: [evidence('a')] }))).toEqual([
        expect.stringMatching(/at least two variants/),
      ]);
    });

    it('rejects a disputed fact whose variants agree', () => {
      expect(
        issuesFor(withFact({ status: 'disputed', note: 'n', variants: [evidence('a'), evidence('a')] })),
      ).toEqual([expect.stringMatching(/different values/)]);
    });

    it('rejects a disputed fact without a note', () => {
      expect(issuesFor(withFact({ status: 'disputed', variants: [evidence('a'), evidence('b')] }))).toEqual([
        expect.stringMatching(/needs a note/),
      ]);
    });

    it('rejects a disputed variant without a source', () => {
      const { source: _source, ...unsourced } = evidence('b');
      expect(issuesFor(withFact({ status: 'disputed', note: 'n', variants: [evidence('a'), unsourced] }))).toEqual([
        expect.stringMatching(/variant 2: missing source/),
      ]);
    });

    it('accepts a disputed fact with two sourced, different variants', () => {
      expect(issuesFor(withFact({ status: 'disputed', note: 'n', variants: [evidence('a'), evidence('b')] }))).toEqual(
        [],
      );
    });

    it('rejects an unknown status', () => {
      expect(issuesFor(withFact({ status: 'probably', ...evidence('x') }))).toEqual([
        expect.stringMatching(/unknown status/),
      ]);
    });

    it('rejects a fact without a value', () => {
      const tool = buildTool();
      deletePath(tool, `${PATH}.value`);
      expect(issuesFor(tool)).toEqual([expect.stringMatching(/missing value/)]);
    });
  });

  describe('structure', () => {
    it('rejects a bare value that is not wrapped in a sourced fact', () => {
      expect(issuesFor(withFact('min-release-age'))).toEqual([expect.stringMatching(/value without a source/)]);
    });

    it('rejects a missing required fact', () => {
      const tool = buildTool();
      deletePath(tool, 'installScripts.allowList.file');
      expect(issuesFor(tool, 'installScripts.allowList.file')).toEqual([
        expect.stringMatching(/required fact is missing/),
      ]);
    });

    it('requires dependency-source facts from package managers only', () => {
      const issues = validateKnowledge([buildTool('dependabot', 'update-bot')], TODAY);
      expect(issues).toEqual([]);
      const npm = buildTool('npm');
      deletePath(npm, 'sources.directory');
      expect(validateKnowledge([npm], TODAY).map((issue) => issue.path)).toEqual([
        'sources.directory.setting',
        'sources.directory.values',
        'sources.directory.availableSince',
        'sources.directory.default',
      ]);
    });

    it('does not require the details of a setting that does not exist', () => {
      const tool = buildTool('bun');
      setPath(tool as unknown as Record<string, unknown>, 'sources.git', {
        setting: verified(null, 'https://bun.com/docs/pm/cli/add#git-dependencies'),
      });
      setPath(tool as unknown as Record<string, unknown>, 'installScripts.allowList', {
        setting: verified(null, 'https://bun.com/docs/pm/lifecycle'),
      });
      expect(validateKnowledge([tool], TODAY)).toEqual([]);
    });

    it('still requires the details when any variant of a disputed setting exists', () => {
      const tool = buildTool('bun');
      setPath(tool as unknown as Record<string, unknown>, 'sources.git', {
        setting: {
          status: 'disputed',
          note: 'n',
          variants: [
            { value: null, source: 'https://bun.com/docs/a', verifiedAt: TODAY },
            { value: 'blockExotic', source: 'https://bun.com/docs/b', verifiedAt: TODAY },
          ],
        },
      });
      expect(validateKnowledge([tool], TODAY).map((issue) => issue.path)).toEqual([
        'sources.git.values',
        'sources.git.availableSince',
        'sources.git.default',
      ]);
    });

    it('rejects an unknown tool id', () => {
      const tool = { ...buildTool(), id: 'pip' } as unknown as ToolKnowledge;
      expect(issuesFor(tool, 'id')).toEqual([expect.stringMatching(/unknown tool id 'pip'/)]);
    });

    it('rejects duplicate tool ids', () => {
      const issues = validateKnowledge([buildTool('npm'), buildTool('npm')], TODAY);
      expect(issues).toContainEqual(expect.objectContaining({ path: 'id', message: 'duplicate tool id' }));
    });

    it('reports the tool and path of every issue', () => {
      const tool = buildTool('pnpm');
      getPath(tool, 'sources.git.setting')['source'] = '';
      expect(validateKnowledge([tool], TODAY)).toEqual([
        { tool: 'pnpm', path: 'sources.git.setting', message: 'missing source URL' },
      ]);
    });
  });
});
