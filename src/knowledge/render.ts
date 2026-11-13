import { collectFacts, evidenceOf, factAt, type FactEntry } from './facts.ts';
import { SOURCE_KINDS } from './schema.ts';
import type { EnvironmentKnowledge, Evidence, Fact, ToolKind, ToolKnowledge } from './types.ts';

type Style = 'code' | 'text';

interface Column {
  title: string;
  /** Path of the fact, relative to the row prefix. */
  path: string;
  style?: Style;
  /** How to show `null`. */
  empty?: string;
  /** How to show an empty list, when not as [] (decision D-170). */
  emptyList?: string;
}

interface Row {
  label: string;
  prefix: string;
}

export interface TableSection {
  heading: string;
  kinds: readonly ToolKind[];
  intro: string;
  rows: (tool: ToolKnowledge) => readonly Row[];
  columns: readonly Column[];
}

const SOURCE_LABELS: Record<(typeof SOURCE_KINDS)[number], string> = {
  git: 'git',
  remoteTarball: 'remote tarball',
  file: 'local tarball',
  directory: 'local directory',
};

const singleRow = (tool: ToolKnowledge): readonly Row[] => [{ label: tool.name, prefix: '' }];

export const TABLE_SECTIONS: readonly TableSection[] = [
  {
    heading: 'Release-age cooldown',
    kinds: ['package-manager', 'update-bot'],
    intro: 'How each tool delays freshly published versions.',
    rows: singleRow,
    columns: [
      { title: 'Setting', path: 'cooldown.setting', style: 'code', empty: 'none' },
      { title: 'Config files', path: 'cooldown.configFiles', style: 'code', emptyList: 'none (no project file)' },
      { title: 'CLI flag', path: 'cooldown.cliFlag', style: 'code', empty: 'none' },
      { title: 'Unit', path: 'cooldown.unit', empty: 'none' },
      { title: 'Since', path: 'cooldown.availableSince', empty: 'n/a' },
      { title: 'Default', path: 'cooldown.default', style: 'code', empty: 'off' },
      { title: 'Exclusions', path: 'cooldown.exclude.setting', style: 'code', empty: 'none' },
      { title: 'Exclusions since', path: 'cooldown.exclude.availableSince', empty: 'n/a' },
      { title: 'Exclusion patterns', path: 'cooldown.exclude.patternSyntax', empty: 'n/a' },
      { title: 'Security updates', path: 'cooldown.securityUpdates', empty: 'n/a' },
    ],
  },
  {
    heading: 'Install scripts',
    kinds: ['package-manager', 'update-bot'],
    intro: 'Whether dependency lifecycle scripts run, and how to allow specific packages.',
    rows: singleRow,
    columns: [
      { title: 'Default policy', path: 'installScripts.defaultPolicy' },
      { title: 'Allow-list setting', path: 'installScripts.allowList.setting', style: 'code', empty: 'none' },
      { title: 'Allow-list file', path: 'installScripts.allowList.file', style: 'code', empty: 'n/a' },
      { title: 'Allow-list since', path: 'installScripts.allowList.availableSince', empty: 'n/a' },
      { title: 'Allow-list format', path: 'installScripts.allowList.format', empty: 'n/a' },
      { title: 'Disable all', path: 'installScripts.disableAll', style: 'code', empty: 'none' },
    ],
  },
  {
    heading: 'Project files',
    kinds: ['package-manager'],
    intro: 'How depcurfew recognizes each package manager in a repository.',
    rows: singleRow,
    columns: [
      { title: 'Lockfiles', path: 'project.lockfiles', style: 'code' },
      { title: 'Manifests', path: 'project.manifests', style: 'code' },
      { title: 'Workspaces', path: 'project.workspaces', style: 'code' },
      { title: 'Object form key', path: 'project.workspacesObjectKey', style: 'code', empty: 'none' },
    ],
  },
  {
    heading: 'Dependency sources',
    kinds: ['package-manager'],
    intro: 'Settings that allow or forbid dependencies from git, remote tarballs and local paths.',
    rows: (tool) => SOURCE_KINDS.map((kind) => ({ label: `${tool.name} · ${SOURCE_LABELS[kind]}`, prefix: `sources.${kind}.` })),
    columns: [
      { title: 'Setting', path: 'setting', style: 'code', empty: 'none' },
      { title: 'Values', path: 'values', style: 'code', empty: 'n/a' },
      { title: 'Since', path: 'availableSince', empty: 'n/a' },
      { title: 'Default', path: 'default', style: 'code', empty: 'n/a' },
    ],
  },
];

function isVersioned(value: unknown): value is readonly { since: string; value: unknown }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'object' && item !== null && 'since' in item && 'value' in item)
  );
}

/** `0.0.0` marks a value whose first version is not tracked. */
function sinceLabel(since: string, entries: number): string {
  if (since !== '0.0.0') return `${since}+`;
  return entries === 1 ? 'all versions' : 'earlier';
}

/** A code span of `text`: a fence longer than any run of backticks in it, padded with a space where CommonMark strips one. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Web addresses in prose, which GitHub links as they are and which are not escaped. */
const URL = /https?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gu;

/**
 * Fact text as Markdown shows it (decision D-141): a backslash and the characters CommonMark would read as markup (code
 * spans, emphasis, links, HTML, entities, strikethrough) are escaped, so that ^pylock\.([^.]+)\.toml$ keeps its
 * backslashes and <job_id> or *\/* stay text. Web addresses are left as they are.
 */
export function escapeMarkdown(text: string): string {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(URL)) {
    result += escapePlain(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + escapePlain(text.slice(last));
}

/**
 * Escapes what CommonMark and GitHub would read as markup, and only that, so the file stays readable: every backslash,
 * backtick, star, tilde and <; an underscore unless it stands between two letters or digits (PIP_CONFIG_FILE is no
 * emphasis); a ] that starts the target of a link (](, ][); and & where it starts an entity (&amp;).
 */
function escapePlain(text: string): string {
  return text.replaceAll(/[\\`*~<]|\](?=[([])|&(?=#?[A-Za-z0-9]+;)|_/gu, (match, offset: number) => {
    if (match === '_' && /[\p{L}\p{N}]/u.test(text[offset - 1] ?? '') && /[\p{L}\p{N}]/u.test(text[offset + 1] ?? '')) return match;
    return `\\${match}`;
  });
}

function formatValue(value: unknown, style: Style, empty: string, emptyList?: string): string {
  if (value === null || value === undefined) return empty;
  if (isVersioned(value)) {
    return value
      .map((entry) => `${sinceLabel(entry.since, value.length)}: ${formatValue(entry.value, style, empty, emptyList)}`)
      .join('<br>');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return emptyList ?? (style === 'code' ? '`[]`' : '[]');
    return value.map((item) => formatValue(item, style, empty)).join(', ');
  }
  if (typeof value === 'object') return codeSpan(JSON.stringify(value));
  const text = String(value);
  return style === 'code' ? codeSpan(text) : escapeMarkdown(text);
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function link(evidence: Evidence<unknown>): string {
  return `[↗](${evidence.source})`;
}

function renderCell(fact: Fact<unknown> | undefined, style: Style, empty: string, emptyList?: string): string {
  if (fact === undefined) return '-';
  if (fact.status === 'disputed') {
    return `⚠️ ${fact.variants.map((variant) => `${formatValue(variant.value, style, empty, emptyList)} ${link(variant)}`).join(' / ')}`;
  }
  const marker = fact.status === 'uncertain' ? ' ❓' : '';
  return `${formatValue(fact.value, style, empty, emptyList)}${marker} ${link(fact)}`;
}

function renderTable(section: TableSection, tools: readonly ToolKnowledge[]): string[] {
  const lines = [
    `## ${section.heading}`,
    '',
    section.intro,
    '',
    `| Tool | ${section.columns.map((column) => column.title).join(' | ')} |`,
    `|${' --- |'.repeat(section.columns.length + 1)}`,
  ];
  for (const tool of tools.filter((entry) => section.kinds.includes(entry.kind))) {
    for (const row of section.rows(tool)) {
      const cells = section.columns.map((column) =>
        escapeCell(renderCell(factAt(tool, row.prefix + column.path), column.style ?? 'text', column.empty ?? 'none', column.emptyList)),
      );
      lines.push(`| ${escapeCell(row.label)} | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  return lines;
}

function statusLabel(fact: Fact<unknown>): string {
  return fact.status === 'disputed' ? '⚠️ disputed' : fact.status === 'uncertain' ? '❓ uncertain' : '✅ verified';
}

function evidenceLine(evidence: Evidence<unknown>, prefix = ''): string {
  const note = evidence.note === undefined ? '' : ` ${escapeMarkdown(evidence.note)}`;
  return `- ${prefix}${formatValue(evidence.value, 'code', '`null`')} · [source](${evidence.source}), verified ${evidence.verifiedAt}.${note}`;
}

function renderExtras(tools: readonly ToolKnowledge[]): string[] {
  const lines = ['## Additional facts', '', 'Further facts used by generators and `doctor`.', ''];
  for (const tool of tools) {
    const extras = collectFacts(tool).filter((entry) => entry.path.startsWith('extra.'));
    if (extras.length === 0) continue;
    lines.push(`### ${tool.name}`, '');
    for (const { path, fact } of extras) {
      lines.push(`- \`${path.slice('extra.'.length)}\` (${statusLabel(fact)}): ${renderCell(fact, 'text', 'none')}`);
    }
    lines.push('');
  }
  return lines;
}

/** A named group of facts: one tool, or the environment. */
interface FactGroup {
  name: string;
  entry: object;
}

const ENVIRONMENT_NAME = 'Environment';

function groups(tools: readonly ToolKnowledge[], environment: EnvironmentKnowledge | undefined): FactGroup[] {
  const named: FactGroup[] = tools.map((tool) => ({ name: tool.name, entry: tool }));
  return environment === undefined ? named : [...named, { name: ENVIRONMENT_NAME, entry: environment }];
}

/** The ecosystems updated by bots only, by name, from the knowledge base (E08): "Go modules, Maven, Gradle and NuGet". */
export function describeBotOnlyEcosystems(environment: EnvironmentKnowledge): string {
  const names = Object.values(environment.botOnlyEcosystems).flatMap((entry) => {
    const project = evidenceOf(entry.project)[0]?.value;
    return project === undefined ? [] : [project.name];
  });
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function renderEnvironment(environment: EnvironmentKnowledge | undefined): string[] {
  if (environment === undefined) return [];
  const lines = [
    '## Environment',
    '',
    `How repositories pin tool versions (Corepack, devEngines, Volta, asdf), how GitHub Actions installs them, and the ecosystems whose new versions only the update bots delay (botOnlyEcosystems: ${describeBotOnlyEcosystems(environment)}).`,
    '',
  ];
  for (const { path, fact } of collectFacts(environment)) {
    lines.push(`- \`${path}\` (${statusLabel(fact)}): ${renderCell(fact, 'text', 'none')}`);
  }
  lines.push('');
  return lines;
}

function renderNotes(groupsToRender: readonly FactGroup[]): string[] {
  const lines = ['## Notes', '', 'Context recorded with verified facts.', ''];
  for (const { name, entry } of groupsToRender) {
    const noted = collectFacts(entry).filter(
      (entry): entry is FactEntry & { fact: Evidence<unknown> & { status: 'verified' } } =>
        entry.fact.status === 'verified' && entry.fact.note !== undefined,
    );
    if (noted.length === 0) continue;
    lines.push(`### ${name}`, '');
    for (const { path, fact } of noted) lines.push(`- \`${path}\`: ${escapeMarkdown(fact.note ?? '')} ${link(fact)}`);
    lines.push('');
  }
  return lines;
}

function renderReview(groupsToRender: readonly FactGroup[]): string[] {
  const lines = [
    '## To review',
    '',
    'Uncertain facts rest on incomplete official sources; disputed facts have official sources that disagree.',
    '',
  ];
  let count = 0;
  for (const { name, entry } of groupsToRender) {
    for (const { path, fact } of collectFacts(entry)) {
      if (fact.status === 'verified') continue;
      count += 1;
      lines.push(`### ${name} · \`${path}\` ${statusLabel(fact)}`, '', escapeMarkdown(fact.note), '');
      if (fact.status === 'disputed') {
        fact.variants.forEach((variant, index) => lines.push(evidenceLine(variant, `Variant ${index + 1}: `)));
      } else {
        lines.push(evidenceLine({ value: fact.value, source: fact.source, verifiedAt: fact.verifiedAt }));
      }
      lines.push('');
    }
  }
  if (count === 0) lines.push('Nothing to review.', '');
  return lines;
}

function renderSummary(tools: readonly ToolKnowledge[], groupsToRender: readonly FactGroup[]): string {
  const facts = groupsToRender.flatMap(({ entry }) => collectFacts(entry).map((item) => item.fact));
  const dates = facts.flatMap((fact) => evidenceOf(fact).map((evidence) => evidence.verifiedAt)).sort();
  const uncertain = facts.filter((fact) => fact.status === 'uncertain').length;
  const disputed = facts.filter((fact) => fact.status === 'disputed').length;
  const range = dates.length === 0 ? 'never' : `${dates[0]} to ${dates[dates.length - 1]}`;
  return `${tools.length} tools · ${facts.length} facts · ${uncertain} uncertain · ${disputed} disputed · verified ${range}.`;
}

export function renderKnowledgeMarkdown(tools: readonly ToolKnowledge[], environment?: EnvironmentKnowledge): string {
  const all = groups(tools, environment);
  const lines = [
    '<!-- Generated by `npm run docs:knowledge` from src/knowledge/. Do not edit by hand. -->',
    '',
    '# Package manager knowledge base',
    '',
    'The facts depcurfew relies on, each linked to the official documentation or changelog it was verified against.',
    '',
    'Legend: ↗ source · ❓ uncertain (official sources are incomplete) · ⚠️ disputed (official sources disagree; every variant is shown) · `1.2.3+` means "from version 1.2.3".',
    '',
    renderSummary(tools, all),
    '',
    ...TABLE_SECTIONS.flatMap((section) => renderTable(section, tools)),
    ...renderExtras(tools),
    ...renderEnvironment(environment),
    ...renderNotes(all),
    ...renderReview(all),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
