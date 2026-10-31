// Generated sections of README.md: everything there that states a fact about a package manager, a bot or GitHub
// comes from the knowledge base, the policy definition, the doctor rules, apply's codes or action.yml.
// `npm run docs:readme` rewrites the text between the markers; tests/docs/readme.test.ts checks that README.md is
// up to date.
import { parse as parseYaml } from 'yaml';
import { isRecord, values } from '../apply/facts.ts';
import { APPLY_ERRORS, APPLY_WARNINGS } from '../apply/warnings.ts';
import { RULES } from '../doctor/index.ts';
import type { Rule } from '../doctor/types.ts';
import { USER_RULES } from '../user/doctor.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import type { CommandLineKnowledge, EnvironmentKnowledge, Fact, ToolKnowledge, UserConfigKnowledge, UserDirectory, UserFile, UserPlatform } from '../knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../policy/defaults.ts';
import { policyJsonSchema } from '../policy/json-schema.ts';

export interface ReadmeInputs {
  tools: readonly ToolKnowledge[];
  environment: EnvironmentKnowledge;
  /** Text of action.yml. */
  action: string;
  /** Text of a workflow whose actions/checkout pin the example reuses. */
  workflow: string;
}

/** The knowledge base document on GitHub: npmjs.com shows the README without the files of the repository. */
export const KNOWLEDGE_DOCUMENT = 'https://github.com/DevXord/depcurfew/blob/main/docs/knowledge.md';

/**
 * The release the example workflow pins the action to: its full commit, with the tag in a comment. Updated after each
 * release (docs/RELEASING.md, „Każde wydanie”), then npm run docs:readme.
 */
export const ACTION_RELEASE = { version: '1.1.0', commit: '77ecd935be36510cae04290423cb02681080403f' } as const;

const SOURCE_LABELS: Record<(typeof SOURCE_KINDS)[number], string> = {
  git: 'git',
  remoteTarball: 'remote tarball',
  file: 'local tarball',
  directory: 'local directory',
};

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** The values of a fact as text, with ⚠️ when official sources disagree and ❓ when they are incomplete. */
function shown(fact: Fact<unknown> | undefined, format: (value: unknown) => string): string | undefined {
  if (fact === undefined) return undefined;
  const all = [...new Set(evidenceOf(fact).map((evidence) => format(evidence.value)))];
  const mark = fact.status === 'disputed' ? ' ⚠️' : fact.status === 'uncertain' ? ' ❓' : '';
  return `${all.join(' / ')}${mark}`;
}

const code = (value: unknown) => (value === null || value === undefined ? 'none' : `\`${String(value)}\``);
const plain = (value: unknown) => (value === null || value === undefined ? 'n/a' : String(value).replaceAll('-', ' '));

function setting(fact: Fact<string | null> | undefined): string | undefined {
  return fact === undefined || values(fact).every((value) => value === null) ? undefined : shown(fact, code);
}

function verifiedRange(tool: ToolKnowledge): string {
  const dates: string[] = [];
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    if (typeof node['verifiedAt'] === 'string') dates.push(node['verifiedAt']);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(tool);
  const sorted = [...new Set(dates)].sort();
  return sorted.length <= 1 ? (sorted[0] ?? 'n/a') : `${sorted[0] ?? ''} – ${sorted.at(-1) ?? ''}`;
}

function toolsTable(tools: readonly ToolKnowledge[]): string {
  const rows = tools.map((tool) => {
    const cooldownSetting = setting(tool.cooldown.setting);
    const files = shown(tool.cooldown.configFiles, (value) => {
      const list = Array.isArray(value) ? (value as unknown[]).map(String) : [String(value)];
      return list.length > 2 ? `${list.slice(0, 2).map(code).join(', ')} …` : list.map(code).join(', ');
    });
    // A tool without a project file for the setting (pip) takes it from the environment or the command line.
    const where = files === undefined || files === '' ? 'on the command line or in the environment (no project file)' : `in ${files}`;
    const delay =
      cooldownSetting === undefined
        ? 'none'
        : `${cooldownSetting} ${where} (${shown(tool.cooldown.unit, plain) ?? 'n/a'}), since ${shown(tool.cooldown.availableSince, plain) ?? 'n/a'}`;
    const excludeSetting = setting(tool.cooldown.exclude.setting);
    const exceptions = excludeSetting === undefined ? 'none' : `${excludeSetting}, since ${shown(tool.cooldown.exclude.availableSince, plain) ?? 'n/a'}`;
    const allowSetting = setting(tool.installScripts.allowList.setting);
    const allowFile = shown(tool.installScripts.allowList.file, code);
    const scripts = allowSetting === undefined ? 'none' : `${allowSetting}${allowFile === undefined ? '' : ` in ${allowFile}`}`;
    const sources =
      tool.sources === undefined
        ? 'n/a'
        : SOURCE_KINDS.flatMap((kind) => {
            const value = setting(tool.sources?.[kind].setting);
            return value === undefined ? [] : [`${SOURCE_LABELS[kind]}: ${value}`];
          }).join('<br>') || 'none';
    return `| ${[tool.name, delay, exceptions, scripts, sources, verifiedRange(tool)].map(cell).join(' | ')} |`;
  });
  return [
    '| Tool | Release-age delay | Exceptions | Install-script allow-list (Python: packages built from source) | Dependency sources | Verified |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `⚠️ official sources disagree (depcurfew takes the safer reading) · ❓ official sources are incomplete. Every value with its source: [docs/knowledge.md](${KNOWLEDGE_DOCUMENT}).`,
  ].join('\n');
}

function policyTable(): string {
  const rows: string[] = [];
  const visit = (schema: unknown, path: string) => {
    if (!isRecord(schema) || !isRecord(schema['properties'])) return;
    for (const [name, child] of Object.entries(schema['properties'])) {
      if (!isRecord(child) || name === '$schema') continue;
      const field = path === '' ? name : `${path}.${name}`;
      const allowed = Array.isArray(child['enum']) ? (child['enum'] as unknown[]).map((value) => `\`${JSON.stringify(value)}\``).join(', ') : '';
      const fallback = 'default' in child ? `\`${JSON.stringify(child['default'])}\`` : '';
      rows.push(`| ${[`\`${field}\``, allowed, fallback, String(child['description'] ?? '')].map(cell).join(' | ')} |`);
      visit(child, field);
    }
  };
  visit(policyJsonSchema(), '');
  return ['| Field | Values | Default | Meaning |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function rulesList(rules: readonly Rule[] = RULES): string {
  return rules.map((rule) =>
    [
      `### \`${rule.id}\``,
      '',
      `**${rule.level}**${rule.requiresPolicy ? ' · needs depcurfew.json' : ''} · ${rule.summary}`,
      '',
      rule.description,
      '',
      `Fix: ${rule.help}`,
    ].join('\n'),
  ).join('\n\n');
}

function applyCodes(): string {
  const list = (codes: Readonly<Record<string, string>>) => Object.entries(codes).map(([code, summary]) => `- \`${code}\`: ${summary}`);
  return ['Warnings:', '', ...list(APPLY_WARNINGS), '', 'Errors (nothing is written):', '', ...list(APPLY_ERRORS)].join('\n');
}

function actionTables(action: string): string {
  const document = parseYaml(action) as unknown;
  const section = (key: 'inputs' | 'outputs', heading: string, withDefault: boolean) => {
    const entries = isRecord(document) && isRecord(document[key]) ? Object.entries(document[key]) : [];
    const header = withDefault ? `| ${heading} | Default | Description |\n| --- | --- | --- |` : `| ${heading} | Description |\n| --- | --- |`;
    const rows = entries.map(([name, value]) => {
      const entry = isRecord(value) ? value : {};
      const columns = withDefault ? [`\`${name}\``, `\`${String(entry['default'] ?? '')}\``, String(entry['description'] ?? '')] : [`\`${name}\``, String(entry['description'] ?? '')];
      return `| ${columns.map(cell).join(' | ')} |`;
    });
    return [header, ...rows].join('\n');
  };
  return [section('inputs', 'Input', true), '', section('outputs', 'Output', false)].join('\n');
}

function exampleWorkflow(environment: EnvironmentKnowledge, workflow: string): string {
  const upload = values(environment.githubActions.codeScanningUpload)[0];
  const checkout = /uses: (actions\/checkout@[0-9a-f]{40} # v[\d.]+)/u.exec(workflow)?.[1];
  if (upload === undefined || checkout === undefined) throw new Error('README: missing the code scanning facts or the checkout pin');
  const permissions = (map: Readonly<Record<string, string>>, indent: string) => Object.entries(map).map(([name, access]) => `${indent}${name}: ${access}`);
  return [
    '```yaml',
    'name: depcurfew',
    '',
    'on:',
    '  push:',
    '  pull_request:',
    '',
    'jobs:',
    '  doctor:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    permissions:',
    ...permissions(upload.permissions.always, '      '),
    '      # Only needed in private repositories:',
    ...permissions(upload.permissions.privateRepositories, '      '),
    '    steps:',
    `      - uses: ${checkout}`,
    '        with:',
    '          persist-credentials: false',
    `      - uses: DevXord/depcurfew@${ACTION_RELEASE.commit} # v${ACTION_RELEASE.version}`,
    '```',
  ].join('\n');
}

function commandList(entries: readonly (readonly string[])[]): string {
  return entries.map((entry) => `\`${entry.join(' ')}\``).join(', ');
}

/** The Claude Code hook settings and the install commands the guard reads, from the knowledge base. */
function claudeCodeHook(environment: EnvironmentKnowledge, tools: readonly ToolKnowledge[]): string {
  const hooks = values(environment.claudeCode.hooks)[0];
  const shellTools = values(environment.claudeCode.shellTools)[0];
  if (hooks === undefined || shellTools === undefined) throw new Error('README: missing the Claude Code hooks or shell tools fact');
  const matcher = shellTools.map((entry) => entry.tool).join(hooks.matcherSeparator);
  const keys = hooks.settings;
  const settings = {
    [keys.hooks]: {
      [hooks.event]: [
        {
          [keys.matcher]: matcher,
          [keys.handlers]: [
            {
              [keys.type]: keys.commandType,
              [keys.command]: 'node',
              [keys.args]: [`${hooks.projectDir}/node_modules/depcurfew/dist/cli.js`, 'check', '--hook', 'claude-code'],
              [hooks.onFailure.field]: hooks.onFailure.value,
            },
          ],
        },
      ],
    },
  };
  // A tool may have several command-line facts (pip has pipx's too); each makes a row named after its executable.
  const rows = tools.flatMap((tool) =>
    Object.keys(tool.extra ?? {})
      .filter((key) => /(?:^c|C)ommandLine$/u.test(key))
      .flatMap((key) => {
        const fact = tool.extra?.[key];
        const commandLine = fact === undefined ? undefined : (values(fact)[0] as CommandLineKnowledge | undefined);
        if (commandLine === undefined) return [];
        const add = commandList(commandLine.add);
        const run = commandList(commandLine.run.map((entry) => entry.command));
        const create = commandList(commandLine.create.map((entry) => entry.command));
        const name = key === 'commandLine' ? tool.name : (commandLine.add[0]?.[0] ?? commandLine.run[0]?.command[0] ?? key);
        return [`| ${name} | ${add === '' ? 'none' : add} | ${run === '' ? 'none' : run} | ${create === '' ? 'none' : create} |`];
      }),
  );
  return [
    `In \`${hooks.settingsFile}\` of the project:`,
    '',
    '```json',
    JSON.stringify(settings, null, 2),
    '```',
    '',
    `The matcher \`${matcher}\` covers every tool that runs shell commands. On Windows, PowerShell is the main shell wherever the PowerShell tool is on, and without Git Bash there is no Bash tool, so a hook on \`Bash\` alone never runs there; Monitor runs a command in the background. \`${hooks.settings.command}\` is \`node\` itself, which also starts on Windows, where Claude Code runs it without a shell.`,
    '',
    `\`${hooks.onFailure.field}: "${hooks.onFailure.value}"\` needs Claude Code ${hooks.onFailure.since} or later; without it, a hook that fails to start, crashes or times out lets the command through.`,
    '',
    'Commands the guard reads (an add subcommand of any npm package manager, such as `install` or `i`, is checked for all of them; Python commands are matched word for word, and `python -m pip` counts as `pip`):',
    '',
    '| Package manager | Add packages | Download and run | Starter kits |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const PLATFORM_NAMES: Readonly<Record<UserPlatform, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

function directoryText(directory: UserDirectory, platform: UserPlatform): string {
  const separator = platform === 'win32' ? '\\' : '/';
  const base = directory.from === 'home' ? '~' : platform === 'win32' ? `%${directory.from.env}%` : `$${directory.from.env}`;
  const path = directory.path === '' ? '' : `${separator}${directory.path.split('/').join(separator)}`;
  return `${base}${path}`;
}

/** Where each tool's user file is, per platform, as apply --user and doctor --user find it. */
function userFileText(file: UserFile): string {
  return file.locations
    .map((location) => {
      const platform = location.platforms[0] ?? 'linux';
      const separator = platform === 'win32' ? '\\' : '/';
      const where = location.directories
        .map((directory) => {
          const conditions = [
            ...(directory.ifExists === true ? ['the folder exists'] : []),
            ...(directory.unlessEnv === undefined ? [] : [`${platform === 'win32' ? `%${directory.unlessEnv}%` : `$${directory.unlessEnv}`} is not set`]),
          ];
          return `\`${directoryText(directory, platform)}${separator}${location.file}\`${conditions.length === 0 ? '' : ` (when ${conditions.join(' and ')})`}`;
        })
        .join(', else ');
      return `${location.platforms.map((name) => PLATFORM_NAMES[name]).join(', ')}: ${where}`;
    })
    .join('<br>');
}

/** The user-level configuration of each package manager, from the knowledge base (user.*). */
function userTable(tools: readonly ToolKnowledge[]): string {
  const rows = tools
    .filter((tool) => tool.kind === 'package-manager' && tool.user !== undefined)
    .map((tool) => {
      const user = tool.user as UserConfigKnowledge;
      const files = (values(user.files)[0] ?? []).map((entry) => (entry.value === null ? `${entry.since === '0.0.0' ? '' : `${entry.since}+: `}none` : `${entry.since === '0.0.0' ? '' : `${entry.since}+: `}${userFileText(entry.value)}`));
      const settings = (values(user.settings)[0] ?? []).map((setting) => `\`${setting.key}\` (${setting.since}${setting.until === undefined ? '+' : `–${setting.until}`})`);
      const exact = values(user.invalidValueFails).some((value) => value) ? 'yes' : 'no';
      return `| ${tool.name} | ${files.join('<br>') || 'none'} | ${settings.join(', ') || 'none'} | ${exact} |`;
    });
  return ['| Tool | User file | Settings `apply --user` writes (versions that read them there) | Needs the exact version |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function readmeSections(inputs: ReadmeInputs): Record<string, string> {
  return {
    'user-config': userTable(inputs.tools),
    'user-rules': rulesList(USER_RULES),
    'default-policy': ['```json', renderPolicy(DEFAULT_POLICY).trimEnd(), '```'].join('\n'),
    'policy-fields': policyTable(),
    tools: toolsTable(inputs.tools),
    rules: rulesList(),
    'apply-codes': applyCodes(),
    'action-reference': actionTables(inputs.action),
    'action-workflow': exampleWorkflow(inputs.environment, inputs.workflow),
    'claude-code-hook': claudeCodeHook(inputs.environment, inputs.tools),
  };
}

const MARKER = /(<!-- BEGIN GENERATED: ([a-z-]+) -->\n)[\s\S]*?(<!-- END GENERATED: \2 -->)/gu;

/** README.md with every generated section replaced; throws when a section has no markers. */
export function renderReadme(readme: string, inputs: ReadmeInputs): string {
  const sections = readmeSections(inputs);
  const seen = new Set<string>();
  const result = readme.replace(MARKER, (_match, start: string, name: string, end: string) => {
    const content = sections[name];
    if (content === undefined) throw new Error(`README: unknown generated section "${name}"`);
    seen.add(name);
    return `${start}${content}\n${end}`;
  });
  const missing = Object.keys(sections).filter((name) => !seen.has(name));
  if (missing.length > 0) throw new Error(`README: no markers for ${missing.join(', ')}`);
  return result;
}

/** README.md without its generated sections, for checks on the hand-written text. */
export function handWritten(readme: string): string {
  return readme.replace(MARKER, '$1$3');
}
