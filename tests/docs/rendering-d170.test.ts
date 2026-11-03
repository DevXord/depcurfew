// Decision D-170: the generated tables of README.md and docs/knowledge.md show dates and versions as they are, the
// setting and unit of each file where a tool reads its delay from files with different keys (Deno), a tool without a
// project file (pip) in words, and the user files of each version range.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readmeSections } from '../../src/docs/readme.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { renderKnowledgeMarkdown } from '../../src/knowledge/render.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const sections = readmeSections({ tools: knowledgeBase, environment, action: read('action.yml'), workflow: read('.github/workflows/ci.yml') });
const row = (table: string | undefined, name: string) => (table ?? '').split('\n').find((line) => line.startsWith(`| ${name} |`)) ?? '';

describe('the tools table of README.md', () => {
  it('keeps the dashes of dates and versions, and writes units as words', () => {
    expect(row(sections['tools'], 'Dependabot')).toContain('(days), since 2025-07-01 |');
    expect(row(sections['tools'], 'Dependabot')).toContain('`cooldown.exclude`, since 2025-07-01 ❓');
    expect(sections['tools']).not.toMatch(/\d{4} \d\d \d\d/u);
    expect(row(sections['tools'], 'uv')).toContain('`exclude-newer` in `uv.toml`, `pyproject.toml` (duration string), since 0.9.17');
  });

  it('names the setting and unit of each file where they differ', () => {
    expect(row(sections['tools'], 'Deno')).toContain('`minimumDependencyAge` in `deno.json` (minutes) or `min-release-age` in `.npmrc` (days), since 2.5.5 / 2.6.0 ⚠️');
    expect(row(sections['tools'], 'npm')).toContain('`min-release-age` in `.npmrc` (days), since 11.10.0');
  });

  it('says in words that pip has no project file', () => {
    expect(row(sections['tools'], 'pip')).toContain('`uploaded-prior-to` (days) on the command line or in the environment, no project file, since 26.1.0');
  });
});

describe('the user files table of README.md', () => {
  it('shows each version range of the Bun and pip user files', () => {
    expect(row(sections['user-config'], 'Bun')).toContain(
      'Linux, macOS, Windows: `$XDG_CONFIG_HOME/.bunfig.toml` (when it is set, also to an empty value), else `~/.bunfig.toml`<br>1.4.4+: Linux, macOS, Windows: `$XDG_CONFIG_HOME/.bunfig.toml` (when it is an absolute path), else `~/.bunfig.toml`',
    );
    expect(row(sections['user-config'], 'pip')).toContain(
      '26.3.0+: Linux: `$XDG_CONFIG_HOME/pip/pip.conf` (when it is an absolute path), else `~/.config/pip/pip.conf`<br>macOS: `$XDG_DATA_HOME/pip/pip.conf` (when it is an absolute path and the folder exists), else `~/Library/Application Support/pip/pip.conf` (when the folder exists and $XDG_DATA_HOME is not an absolute path), else `~/.config/pip/pip.conf`',
    );
  });
});

describe('docs/knowledge.md', () => {
  const markdown = renderKnowledgeMarkdown(knowledgeBase, environment);

  it('says that pip has no project file instead of showing an empty list', () => {
    const pip = markdown.split('\n').find((line) => line.startsWith('| pip | `uploaded-prior-to`')) ?? '';
    expect(pip.split(' | ')[2]).toMatch(/^none \(no project file\) \[↗\]/u);
    expect(markdown).not.toContain('`[]` [↗]');
  });
});
