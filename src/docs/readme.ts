// Generated sections of README.md: everything there that states a fact about a package manager, a bot or GitHub
// comes from the knowledge base, the policy definition, the doctor rules, apply's codes or action.yml.
// `npm run docs:readme` rewrites the text between the markers; tests/docs/readme.test.ts checks that README.md is
// up to date.
import { parse as parseYaml } from 'yaml';
import { isRecord, values } from '../apply/facts.ts';
import { APPLY_ERRORS, APPLY_WARNINGS } from '../apply/warnings.ts';
import { INIT_NOTES, INIT_WARNINGS } from '../cli/init-codes.ts';
import { RULES } from '../doctor/index.ts';
import type { Rule } from '../doctor/types.ts';
import { USER_RULES } from '../user/doctor.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import type { ChecksumCommandKnowledge, CommandLineKnowledge, CommandNamesKnowledge, CommandNeedsKnowledge, EnvironmentKnowledge, ExecPromptKnowledge, ExecReleaseAgeKnowledge, ExecutableAliasesKnowledge, Fact, PrefixOptionKnowledge, SharedRunKnowledge, ToolKnowledge, UserConfigKnowledge, UserDirectory, UserFile, UserPlatform } from '../knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../policy/defaults.ts';
import { policyJsonSchema } from '../policy/json-schema.ts';
import { INSTALLED_CLI, TOOLS_DIRECTORY } from '../self-version.ts';

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
export const ACTION_RELEASE = { version: '1.6.0', commit: 'cc7f3752f959bf831a11c7365de9dd307029d458' } as const;

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
/** A unit in words: duration-string is "duration string". */
const unitWords = (value: unknown) => (value === null || value === undefined ? 'n/a' : String(value).replaceAll('-', ' '));
/** A version or date as it is written (2025-07-01 keeps its dashes). */
const asWritten = (value: unknown) => (value === null || value === undefined ? 'n/a' : String(value));

function setting(fact: Fact<string | null> | undefined): string | undefined {
  return fact === undefined || values(fact).every((value) => value === null) ? undefined : shown(fact, code);
}

function verifiedRange(tool: object): string {
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

/**
 * The ecosystems updated by bots only (decision D-151), one row each after the bots: the release-age delay of the
 * package manager itself, which depcurfew does not configure, and the bot entries and managers that wait instead. Only
 * in a table with an update bot, so that the start pages of the package managers leave them out.
 */
function botEcosystemRows(tools: readonly ToolKnowledge[], environment: EnvironmentKnowledge | undefined): string[] {
  const bots = tools.filter((tool) => tool.kind === 'update-bot');
  if (environment === undefined || bots.length === 0) return [];
  const names = (tool: ToolKnowledge, key: 'ecosystem' | 'manager'): Record<string, string> => {
    const fact = tool.extra?.['botOnlyEcosystems'];
    const value = fact === undefined ? undefined : values(fact)[0];
    return isRecord(value) ? Object.fromEntries(Object.entries(value).flatMap(([id, entry]) => (isRecord(entry) && typeof entry[key] === 'string' ? [[id, entry[key]]] : []))) : {};
  };
  const dependabot = bots.find((tool) => tool.id === 'dependabot');
  const renovate = bots.find((tool) => tool.id === 'renovate');
  return Object.entries(environment.botOnlyEcosystems).map(([id, entry]) => {
    const project = values(entry.project)[0];
    const delay = shown(entry.releaseAge, (value) => {
      if (!isRecord(value) || typeof value['setting'] !== 'string' || typeof value['since'] !== 'string') return 'none';
      const file = typeof value['file'] === 'string' ? ` in ${code(value['file'])}` : '';
      const product = typeof value['product'] === 'string' ? `${value['product']} ` : '';
      // The commands that apply the setting (decision D-205); the deprecated updatesOnly only without them.
      const commands = Array.isArray(value['selectedBy']) ? (value['selectedBy'] as unknown[]).map(String) : [];
      const named = commands.length <= 1 ? commands.map(code).join('') : `${commands.slice(0, -1).map(code).join(', ')} and ${code(commands.at(-1) ?? '')}`;
      const scope = commands.length > 0 ? `, only for the versions ${named} choose` : value['updatesOnly'] === true ? ', for updates only' : '';
      return `${code(value['setting'])}${file}, since ${product}${value['since']}${scope} (depcurfew does not write it)`;
    });
    const through = [
      ...(dependabot === undefined || names(dependabot, 'ecosystem')[id] === undefined ? [] : [`Dependabot ${code(names(dependabot, 'ecosystem')[id])}`]),
      ...(renovate === undefined || names(renovate, 'manager')[id] === undefined ? [] : [`Renovate ${code(names(renovate, 'manager')[id])}`]),
    ];
    const cellText = `${delay ?? 'none'}; the delay comes from the bots: ${through.join(', ')}`;
    return `| ${[`${project?.name ?? id} (bots only)`, cellText, 'n/a', 'n/a', 'n/a', verifiedRange(entry)].map(cell).join(' | ')} |`;
  });
}

function toolsTable(tools: readonly ToolKnowledge[], environment?: EnvironmentKnowledge): string {
  const rows = tools.map((tool) => {
    const cooldownSetting = setting(tool.cooldown.setting);
    // Files that take the delay under another key or in another unit (Deno's .npmrc) get their own part (decision D-170).
    const fileSettings = tool.cooldown.fileSettings === undefined ? [] : (values(tool.cooldown.fileSettings)[0] ?? []);
    const special = new Set(fileSettings.map((entry) => entry.file));
    const files = shown(tool.cooldown.configFiles, (value) => {
      const list = (Array.isArray(value) ? (value as unknown[]).map(String) : [String(value)]).filter((file) => !special.has(file));
      return list.length > 2 ? `${list.slice(0, 2).map(code).join(', ')} …` : list.map(code).join(', ');
    });
    const unit = shown(tool.cooldown.unit, unitWords) ?? 'n/a';
    const others = fileSettings.map((entry) => `${code(entry.setting)} in ${code(entry.file)} (${unitWords(entry.unit)})`);
    // A tool without a project file for the setting (pip) takes it from the environment or the command line.
    const where =
      files === undefined || files === ''
        ? others.length > 0
          ? others.join(' or ')
          : `${cooldownSetting ?? ''} (${unit}) on the command line or in the environment, no project file`
        : [`${cooldownSetting ?? ''} in ${files} (${unit})`, ...others].join(' or ');
    const delay = cooldownSetting === undefined ? 'none' : `${where}, since ${shown(tool.cooldown.availableSince, asWritten) ?? 'n/a'}`;
    const excludeSetting = setting(tool.cooldown.exclude.setting);
    const exceptions = excludeSetting === undefined ? 'none' : `${excludeSetting}, since ${shown(tool.cooldown.exclude.availableSince, asWritten) ?? 'n/a'}`;
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
    '| Tool | Release-age delay | Exceptions | Install-script allow-list (Python: packages built from source; Composer: plugins) | Dependency sources | Verified |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    ...botEcosystemRows(tools, environment),
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

/**
 * `fallback`: what a rule that needs the policy does without one; doctor compares with the default policy (decision
 * D-149). `also`: what a rule that runs without one but finds more with one adds then (decision D-154).
 */
function rulesList(rules: readonly Rule[] = RULES, fallback = ' (without one: a note against the default policy)', also = ' · without depcurfew.json also a note against the default policy'): string {
  return rules.map((rule) =>
    [
      `### \`${rule.id}\``,
      '',
      `**${rule.level}**${rule.requiresPolicy ? ` · needs depcurfew.json${fallback}` : rule.alsoWithDefaultPolicy === true ? also : ''} · ${rule.summary}`,
      '',
      rule.description,
      '',
      `Fix: ${rule.help}`,
    ].join('\n'),
  ).join('\n\n');
}

function codeList(codes: Readonly<Record<string, string>>): string[] {
  return Object.entries(codes).map(([code, summary]) => `- \`${code}\`: ${summary}`);
}

function applyCodes(): string {
  return ['Warnings:', '', ...codeList(APPLY_WARNINGS), '', 'Errors (nothing is written):', '', ...codeList(APPLY_ERRORS)].join('\n');
}

/** The warnings and notes of init (decision D-122); its errors are those of apply. */
function initCodes(): string {
  return ['Warnings:', '', ...codeList(INIT_WARNINGS), '', 'Notes:', '', ...codeList(INIT_NOTES)].join('\n');
}

function actionTables(action: string): string {
  const document = parseYaml(action) as unknown;
  const section = (key: 'inputs' | 'outputs', heading: string, withDefault: boolean) => {
    const entries = isRecord(document) && isRecord(document[key]) ? Object.entries(document[key]) : [];
    const header = withDefault ? `| ${heading} | Default | Description |\n| --- | --- | --- |` : `| ${heading} | Description |\n| --- | --- |`;
    const rows = entries.map(([name, value]) => {
      const entry = isRecord(value) ? value : {};
      // An empty default (fail-on) is shown as "empty": an empty code span would show the backticks.
      const fallback = String(entry['default'] ?? '');
      const shown = fallback === '' ? 'empty' : `\`${fallback}\``;
      const columns = withDefault ? [`\`${name}\``, shown, String(entry['description'] ?? '')] : [`\`${name}\``, String(entry['description'] ?? '')];
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
    '      # The depcurfew doctor check with the result in the Checks tab:',
    '      checks: write',
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

/**
 * The release the verification commands of "Verifying a release" check: the newest one whose package equals the build of
 * its tag. It follows ACTION_RELEASE, in the same pull request after each release, but only once the Verify release
 * workflow (or the commands of the README) gave the same checksum for the tag and for the registry. A release whose
 * package is not the build of its tag goes into UNVERIFIABLE_RELEASES, and VERIFIED_RELEASE stays at the release before
 * it (tests/docs/install-paths-d206.test.ts, decision D-206).
 */
export const VERIFIED_RELEASE = { version: '1.6.0' } as const;

/**
 * Releases whose package is not the build of their tag: 1.5.0 lists the properties of one type of its declaration file
 * in another order than a build of the tag does (decision D-174). The README names this exception by hand.
 */
export const UNVERIFIABLE_RELEASES = ['1.5.0'] as const;

/**
 * The release the npx example of "In a repository without package.json" runs: the newest release that was at least
 * 7 days old when the pull request after a release was made, usually the one before it, so that the default delay of
 * cooldown.minimum, depcurfew's hook and npm's release-age delay all let it through (decision D-206). Never newer than
 * ACTION_RELEASE.
 */
export const NPX_RELEASE = { version: '1.5.2' } as const;

/** The first value of an npm fact of the knowledge base the README needs. */
function npmFact<T>(tools: readonly ToolKnowledge[], name: string): T {
  const fact = tools.find((tool) => tool.id === 'npm')?.extra?.[name];
  const value = fact === undefined ? undefined : values(fact)[0];
  if (value === undefined) throw new Error(`README: missing the npm fact extra.${name}`);
  return value as T;
}

/** The commands that check a release against its tag, for VERIFIED_RELEASE, with the npm commands of the knowledge base. */
function verifyRelease(tools: readonly ToolKnowledge[]): string {
  const { version } = VERIFIED_RELEASE;
  const pack = npmFact<ChecksumCommandKnowledge>(tools, 'packChecksum');
  const view = npmFact<ChecksumCommandKnowledge>(tools, 'viewChecksum');
  return [
    '```bash',
    `git clone --branch v${version} https://github.com/DevXord/depcurfew.git`,
    'cd depcurfew',
    'npm ci --ignore-scripts',
    'npm run build',
    `${pack.command.join(' ')} | grep ${pack.field}`,
    `${view.command.join(' ')} depcurfew@${version} ${view.field}`,
    '```',
  ].join('\n');
}

/**
 * How a repository without package.json in its root runs a pinned depcurfew (decision D-206): the Action, npx with an
 * exact release old enough for the release-age delays, or the tools directory installed with --prefix, so the commands
 * need no cd and run in any shell.
 */
function withoutPackageJson(tools: readonly ToolKnowledge[]): string {
  const prompt = npmFact<ExecPromptKnowledge>(tools, 'execPrompt');
  const age = npmFact<ExecReleaseAgeKnowledge>(tools, 'execReleaseAge');
  const ci = npmFact<CommandNeedsKnowledge>(tools, 'ciLockfile');
  const prefix = npmFact<PrefixOptionKnowledge>(tools, 'prefixOption');
  const npm = tools.find((tool) => tool.id === 'npm');
  const setting = npm?.cooldown.setting === undefined ? undefined : values(npm.cooldown.setting)[0];
  if (setting === undefined || age.exactTooYoung === undefined) throw new Error('README: missing the release-age delay of npm or the error of npx');
  const runner = prompt.commands[0]?.join(' ') ?? 'npx';
  const assumed = prompt.yesAssumed.map((when) => (when === 'no TTY' ? 'without a terminal' : 'in CI')).join(' or ');
  return [
    'depcurfew is a Node.js program, and a repository without `package.json` in its root, such as a Rust, .NET, Python, PHP or Ruby project, does not need one to run it.',
    '',
    '**In GitHub Actions,** the [GitHub Action](#github-action) needs nothing installed.',
    '',
    `**Once, by hand,** run an exact release with ${runner}:`,
    '',
    '```bash',
    `${runner} ${prompt.confirm} depcurfew@${NPX_RELEASE.version} doctor`,
    '```',
    '',
    `Name a release that is at least as old as \`cooldown.minimum\` of the policy: depcurfew's own [Claude Code hook](#claude-code) denies a younger one, and so does npm where its \`${setting}\` is set (${runner} then fails with \`${age.exactTooYoung}\`). The example names the newest release that was at least 7 days old when this README was written, usually the one before the newest. Without \`${prompt.confirm}\`, ${runner} asks before it downloads a package the project does not have, and ${assumed} it downloads without asking.`,
    '',
    `**Pinned in the repository,** keep depcurfew in the tools directory \`${TOOLS_DIRECTORY}\`: its own \`package.json\` pins depcurfew exactly, its \`${ci.needs}\` is committed and \`${TOOLS_DIRECTORY}/node_modules\` is git-ignored. \`${ci.command.join(' ')}\` installs what that \`${ci.needs}\` locks, and \`${prefix.option}\` runs it in the tools directory, so both commands run from the root of the repository, without \`cd\`:`,
    '',
    '```bash',
    `${ci.command.join(' ')} --ignore-scripts ${prefix.option} ${TOOLS_DIRECTORY}`,
    `node ${TOOLS_DIRECTORY}/${INSTALLED_CLI} doctor`,
    '```',
    '',
    `\`doctor\` reads this copy too: [\`depcurfew-outdated\`](#depcurfew-outdated) says when the depcurfew that runs is older than it, and the [Claude Code hook](#claude-code) can run it. To be offered new releases of the pin, you can add a Dependabot \`npm\` entry for the directory \`/${TOOLS_DIRECTORY}\`; \`apply\` gives it the cooldown of the policy like any other \`npm\` entry. The tools directory and the Action pin their versions separately, so update both.`,
  ].join('\n');
}

function commandList(entries: readonly (readonly string[])[]): string {
  return entries.map((entry) => `\`${entry.join(' ')}\``).join(', ');
}

/**
 * What the hook does before depcurfew is installed, and how to install it first: with onFailure "block" a missing
 * cli.js blocks every shell command, including the install that would bring it (user feedback before 1.3.0).
 */
function bootstrap(environment: EnvironmentKnowledge): string[] {
  const hooks = values(environment.claudeCode.hooks)[0];
  const start = values(environment.claudeCode.sessionStart)[0];
  if (hooks === undefined || start === undefined) throw new Error('README: missing the Claude Code hooks or SessionStart fact');
  const keys = hooks.settings;
  const cli = INSTALLED_CLI;
  const variable = `$${start.projectDirVariable}`;
  const shell = values(environment.claudeCode.hookShell)[0];
  if (shell === undefined) throw new Error('README: missing the Claude Code hook shell fact');
  const sessionStart = {
    [keys.hooks]: {
      [start.event]: [
        {
          [keys.matcher]: start.matchers.join(hooks.matcherSeparator),
          [keys.handlers]: [{ [keys.type]: keys.commandType, [keys.command]: `cd "${variable}" && { test -f ${cli} || npm ci --ignore-scripts; }` }],
        },
      ],
    },
  };
  return [
    '**Before depcurfew is installed.** The hook runs the copy in `node_modules`. When that file is missing (a fresh clone before `npm ci`, a repository without `package.json` in its root, a new cloud session), node still starts, cannot load it and exits with code 1 and a stack trace, and with `' +
      `${hooks.onFailure.field}: "${hooks.onFailure.value}"\` that failure blocks every command of these tools, including the \`npm ci\` that would install depcurfew; without it, every command runs unchecked. The blocked call shows the hook command, \`${start.blockedNotice}\` and node's \`Error: Cannot find module '…/${cli}'\`: run the install (\`npm ci --ignore-scripts\` in the project, or in \`${TOOLS_DIRECTORY}\` for the tools directory below) from a terminal, then try again. So install depcurfew before the hook is needed:`,
    '',
    `- **On your machine:** run \`npm ci\` once after cloning, in a terminal, before you start Claude Code.`,
    `- **In every session:** a \`${start.event}\` hook installs the locked copy when it is missing (with pnpm, Yarn or Bun, use their install from the lockfile instead of \`npm ci\`). It runs when a session starts or resumes, and ${start.firstResponseWaits ? "Claude's first response waits for it" : 'it may still run when Claude answers'}, so the guard is in place before the first command. \`--ignore-scripts\` keeps the install from running dependency scripts before the guard is there. Add it next to \`${hooks.event}\` in the same \`${hooks.settingsFile}\`:`,
    '',
    '```json',
    JSON.stringify(sessionStart, null, 2),
    '```',
    '',
    // Shell form with a command line for sh and Git Bash: Claude Code runs it in PowerShell on Windows without Git Bash.
    `The command is a line for \`sh\` and Bash: a hook without \`${shell.field}\` runs in ${shell.default === 'bash' ? '`sh -c` on macOS and Linux and in Git Bash on Windows' : shell.default}, but ${shell.withoutGitBash === 'powershell' ? 'in PowerShell on Windows when Git Bash is not installed' : shell.withoutGitBash}, where this line fails and installs nothing, so with \`${hooks.onFailure.field}: "${hooks.onFailure.value}"\` the guard then blocks every command. On Windows without Git Bash, install Git for Windows or run the install yourself before you start Claude Code.`,
    '',
    `- **A repository without \`package.json\` in its root** (several projects side by side): keep depcurfew in the tools directory of [In a repository without package.json](#in-a-repository-without-packagejson), \`${TOOLS_DIRECTORY}/package.json\` with depcurfew pinned exactly and its \`package-lock.json\` committed, install it there (\`npm ci --ignore-scripts --prefix ${TOOLS_DIRECTORY}\`, also in the \`${start.event}\` hook), and point the hook at \`${hooks.projectDir}/${TOOLS_DIRECTORY}/${cli}\`.`,
    start.cloudSetupScriptRunsBeforeClaudeCode
      ? `- **Cloud sessions (Claude Code on the web):** the repository's \`${hooks.settingsFile}\` hooks run there, user-level ones do not. The environment's setup script runs before Claude Code starts, so it can install depcurfew too; the \`${start.event}\` hook above covers a cached environment as well.`
      : '',
    `- **Locked out already:** install depcurfew from a terminal outside Claude Code, or remove the hook from \`${hooks.settingsFile}\` there; Claude cannot do it for you while the hook blocks its commands, which is the point of \`${hooks.onFailure.value}\`.`,
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
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
        // The aliases of the tool's command names that stand for a listed command (bun a, bun c; decision D-162).
        const namesFact = key === 'commandLine' ? tool.extra?.['commandNames'] : undefined;
        const names = namesFact === undefined ? undefined : (values(namesFact)[0] as CommandNamesKnowledge | undefined);
        const withAliases = (entries: readonly (readonly string[])[]) =>
          entries.flatMap((entry) => {
            const [executable, command] = entry;
            if (names === undefined || executable === undefined || command === undefined || entry.length !== 2) return [entry];
            const aliases = Object.entries(names.aliases).filter(([alias, target]) => target === command && !entries.some((other) => other[0] === executable && other[1] === alias));
            return [entry, ...aliases.map(([alias]) => [executable, alias])];
          });
        // npm link installs the names the global space lacks before it links them (decision D-172).
        const linksFact = key === 'commandLine' ? tool.extra?.['linkCommands'] : undefined;
        const links = linksFact === undefined ? [] : ((values(linksFact)[0] as readonly (readonly string[])[] | undefined) ?? []);
        // The other names of the program, which the guard reads as the program (pn for pnpm; decision D-193).
        const programsFact = key === 'commandLine' ? tool.extra?.['executableAliases'] : undefined;
        const programs = Object.entries(programsFact === undefined ? {} : ((values(programsFact)[0] as ExecutableAliasesKnowledge | undefined) ?? {}));
        const withPrograms = (entries: readonly (readonly string[])[]) =>
          entries.flatMap((entry) => [entry, ...programs.filter(([, program]) => program === entry[0] && entry.length > 1).map(([alias]) => [alias, ...entry.slice(1)])]);
        const add = commandList(withPrograms(withAliases([...commandLine.add, ...links])));
        const run = commandList(withPrograms(withAliases(commandLine.run.map((entry) => entry.command))));
        const create = commandList(withPrograms(withAliases(commandLine.create.map((entry) => entry.command))));
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
    ...bootstrap(environment),
    '',
    'Commands the guard reads (an add subcommand of any npm package manager, such as `install` or `i`, is checked for all of them, while `npm link` counts for npm alone; npm commands also count abbreviated or in camelCase, as npm resolves them (`npm exe`, `npm installTest`); pnpm, Yarn and Bun take their command names only as written, with the aliases in the table; Python commands are matched word for word, and `python -m pip` counts as `pip`):',
    '',
    '| Package manager | Add packages | Download and run | Starter kits |',
    '| --- | --- | --- | --- |',
    ...rows,
    ...sharedRunNotes(environment, tools),
  ].join('\n');
}

/** a, b and c. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * The program names a tool's run command shares with the .NET SDK (Deno's dnx; decision D-208): which lines count, and
 * that the others, like the SDK's own tool commands, get no decision.
 */
function sharedRunNotes(environment: EnvironmentKnowledge, tools: readonly ToolKnowledge[]): string[] {
  const fact = environment.botOnlyEcosystems.nuget.toolRunner;
  const runner = fact === undefined ? undefined : values(fact)[0];
  const notes = tools.flatMap((tool) => {
    const shared = tool.extra?.['sharedRuns'];
    const entries = shared === undefined ? [] : ((values(shared)[0] as readonly SharedRunKnowledge[] | undefined) ?? []);
    return entries.map((entry) => {
      const program = entry.command.join(' ');
      const prefixes = entry.prefixes.map((prefix) => `\`${prefix}\``).join(' or ');
      const dotnet = runner !== undefined && runner.executables.includes(program);
      const others = dotnet
        ? `; any other \`${program}\` line is the tool runner of the ${runner.product} (${runner.since} and later), which, like ${listed(runner.runs.map((command) => `\`${command.join(' ')}\``))}, gets no decision, as depcurfew does not look NuGet tools up yet`
        : `; any other \`${program}\` line gets no decision`;
      return `\`${program}\` counts for ${tool.name} as \`${entry.runs.join(' ')}\` only when the word right after it is an ${prefixes} spec (\`${program} ${entry.prefixes[0] ?? ''}cowsay\`)${others}.`;
    });
  });
  return notes.length === 0 ? [] : ['', ...notes];
}

/** How the MCP clients start depcurfew mcp, from the knowledge base (environment.mcp.clients). */
function mcpClients(environment: EnvironmentKnowledge): string {
  const claudeCode = values(environment.mcp.clients.claudeCode)[0];
  const desktop = values(environment.mcp.clients.claudeDesktop)[0];
  const vscode = values(environment.mcp.clients.vscode)[0];
  if (claudeCode === undefined || desktop === undefined || vscode === undefined) throw new Error('README: missing the MCP client facts');
  const script = 'node_modules/depcurfew/dist/cli.js';
  const projectScript = `${claudeCode.projectDirReference}/${script}`;
  const json = (value: unknown) => ['```json', JSON.stringify(value, null, 2), '```'];
  const absolute = '/path/to/project';
  const desktopServer = { command: 'node', args: [`${absolute}/${script}`, 'mcp', '--dir', absolute] };
  const vscodeServer = {
    [vscode.typeField]: vscode.stdioType,
    command: 'node',
    args: [`${vscode.workspaceFolder}/${script}`, 'mcp'],
    [vscode.cwdField]: vscode.workspaceFolder,
  };
  const revisions = values(environment.mcp.revisions)[0];
  const lifecycle = values(environment.mcp.lifecycle)[0];
  if (revisions === undefined || lifecycle === undefined) throw new Error('README: missing the MCP protocol facts');
  return [
    `The server speaks the \`${lifecycle.initialize}\` handshake of the protocol revisions ${revisions.legacy.join(', ')} and the stateless revision${revisions.modern.length === 1 ? '' : 's'} ${revisions.modern.join(', ')}, without the handshake, for clients that use ${revisions.modern.length === 1 ? 'it' : 'them'}.`,
    '',
    `**Claude Code.** Add the server to \`${claudeCode.projectFile}\` of the project, which everyone working on it shares (Claude Code asks before it starts a server from that file):`,
    '',
    '```bash',
    `${[...claudeCode.addCommand, claudeCode.scopeOption, claudeCode.projectScope, claudeCode.transportOption, claudeCode.stdioTransport, 'depcurfew', claudeCode.separator, 'node', `'${projectScript}'`, 'mcp'].join(' ')}`,
    '```',
    '',
    `or write \`${claudeCode.projectFile}\` yourself:`,
    '',
    ...json({ [claudeCode.serversKey]: { depcurfew: { command: 'node', args: [projectScript, 'mcp'] } } }),
    '',
    `Claude Code sets \`${claudeCode.projectDirVariable}\` to the project root for the server, and \`depcurfew mcp\` takes it as the project directory. Claude Code itself does not have the variable, so in \`args\` it needs the default \`${claudeCode.projectDirReference}\` (in cmd.exe, leave out the single quotes).`,
    '',
    `**Claude Desktop.** In \`claude_desktop_config.json\` (macOS: \`${desktop.configFiles.darwin}\`, Windows: \`${desktop.configFiles.win32}\`, Linux: \`${desktop.configFiles.linux}\`), with absolute paths and \`--dir\`, because Claude Desktop starts servers in no particular directory:`,
    '',
    ...json({ [desktop.serversKey]: { depcurfew: desktopServer } }),
    '',
    `**VS Code.** In \`${vscode.file}\` of the workspace:`,
    '',
    ...json({ [vscode.serversKey]: { depcurfew: vscodeServer } }),
    '',
    `\`code ${vscode.addOption} '${JSON.stringify({ name: 'depcurfew', [vscode.typeField]: vscode.stdioType, ...desktopServer })}'\` adds the server for one project to your user profile instead.`,
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
          const unless = directory.unlessEnv === undefined ? undefined : typeof directory.unlessEnv === 'string' ? { env: directory.unlessEnv, absolute: false } : directory.unlessEnv;
          const conditions = [
            ...(directory.from !== 'home' && directory.from.emptyCounts === true ? ['it is set, also to an empty value'] : []),
            ...(directory.from !== 'home' && directory.from.absolute === true ? ['it is an absolute path'] : []),
            ...(directory.ifExists === true ? ['the folder exists'] : []),
            ...(unless === undefined ? [] : [`${platform === 'win32' ? `%${unless.env}%` : `$${unless.env}`} ${unless.absolute ? 'is not an absolute path' : 'is not set'}`]),
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
      // Where a library the tool calls decides the directories (platformdirs on macOS), each range of its versions.
      const library = user.libraryDirectories === undefined ? undefined : values(user.libraryDirectories)[0];
      const latest = (values(user.files)[0] ?? []).at(-1)?.value;
      for (const [index, entry] of (library?.directories ?? []).entries()) {
        if (library === undefined || latest === null || latest === undefined) break;
        const until = library.directories[index + 1]?.since;
        const range = entry.since === '0.0.0' ? `before ${until ?? 'any version'}` : until === undefined ? `${entry.since}+` : `${entry.since}–${until}`;
        const platforms = library.platforms.map((name) => PLATFORM_NAMES[name]).join(', ');
        const file = latest.locations.find((location) => location.platforms.some((platform) => library.platforms.includes(platform)));
        if (file === undefined) continue;
        const text = userFileText({ ...latest, locations: [{ ...file, platforms: library.platforms, directories: entry.value }] }).replace(`${platforms}: `, '');
        files.push(`${platforms} with ${library.library} ${range}: ${text}`);
      }
      const settings = (values(user.settings)[0] ?? []).map((setting) => `\`${setting.key}\` (${setting.since}${setting.until === undefined ? '+' : `–${setting.until}`})`);
      const exact = values(user.invalidValueFails).some((value) => value) ? 'yes' : 'no';
      return `| ${tool.name} | ${files.join('<br>') || 'none'} | ${settings.join(', ') || 'none'} | ${exact} |`;
    });
  return ['| Tool | User file | Settings `apply --user` writes (versions that read them there) | Needs the exact version |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function readmeSections(inputs: ReadmeInputs): Record<string, string> {
  const hasNpm = inputs.tools.some((tool) => tool.id === 'npm');
  return {
    'user-config': userTable(inputs.tools),
    // doctor --user has no default policy to compare with.
    'user-rules': rulesList(USER_RULES, '', ''),
    'default-policy': ['```json', renderPolicy(DEFAULT_POLICY).trimEnd(), '```'].join('\n'),
    'policy-fields': policyTable(),
    tools: toolsTable(inputs.tools, inputs.environment),
    rules: rulesList(),
    'apply-codes': applyCodes(),
    'init-codes': initCodes(),
    'action-reference': actionTables(inputs.action),
    'action-workflow': exampleWorkflow(inputs.environment, inputs.workflow),
    // The start pages of the site render the sections of their own tools only; these two need npm's facts.
    'verify-release': hasNpm ? verifyRelease(inputs.tools) : '',
    'without-package-json': hasNpm ? withoutPackageJson(inputs.tools) : '',
    'claude-code-hook': claudeCodeHook(inputs.environment, inputs.tools),
    'mcp-clients': mcpClients(inputs.environment),
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
