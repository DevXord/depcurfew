// `depcurfew doctor --user` (decision D-087): the user-level configuration of the installed tools against the user
// policy (user-config-drift), values in those files that weaken every project (user-config-weakens) and environment
// variables that move, skip or override them (user-environment-overrides). Nothing is written or executed.
import { readFileSync, statSync } from 'node:fs';
import { PolicyError } from '../apply/index.ts';
import type { Version } from '../apply/version.ts';
import { iniLines } from '../doctor/settings.ts';
import type { DoctorReport, Finding, Notice, Rule } from '../doctor/types.ts';
import { parseToml } from '../detect/toml.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge, UserFile, UserSettingPurpose, UserWeakening } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parseYaml } from '../yaml-parse.ts';
import { planUserApply } from './apply.ts';
import { shownPath, userFileFor, userFilePath, type UserEnvironment } from './locate.ts';
import { loadUserPolicy } from './policy.ts';
import { findExecutable, installedVersion } from './versions.ts';

const noCheck = (): void => undefined;

export const USER_RULES: readonly Rule[] = [
  {
    id: 'user-config-drift',
    summary: 'A user-level configuration file does not match the user policy.',
    description:
      'depcurfew apply --user writes the user policy (~/.config/depcurfew/depcurfew.json) into the user-level configuration of each installed tool, which protects every project on the machine that does not set the same settings itself, and npx, uvx and global installs. A file that no longer matches leaves that protection weaker than the policy.',
    help: 'Run depcurfew apply --user.',
    level: 'warning',
    requiresPolicy: true,
    check: noCheck,
  },
  {
    id: 'user-config-weakens',
    summary: 'A user-level configuration file has a value that weakens every project that does not set it itself.',
    description:
      'Settings in the user-level configuration apply to every project that does not set the same key, and some apply even then (lists that tools merge across files). A value that turns the release-age delay off, exempts packages or allows install scripts or git dependencies there weakens all of them at once.',
    help: 'Remove the value from the file, or set it in the policy and run depcurfew apply --user.',
    level: 'warning',
    requiresPolicy: false,
    check: noCheck,
  },
  {
    id: 'user-environment-overrides',
    summary: 'An environment variable moves, skips or overrides the user-level configuration or the policy.',
    description:
      'Package managers read settings from environment variables before their configuration files, and some variables make them read another file or none. A variable set in a shell profile or a CI runner can switch the protection off without any file showing it.',
    help: 'Unset the variable, or set it to a value the policy allows.',
    level: 'warning',
    requiresPolicy: false,
    check: noCheck,
  },
];

const MAX_FILE = 1024 * 1024;

function readFile(path: string): string | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The values at a dotted key; `*` matches every key of an object (npmScopes.*.npmMinimalAgeGate). */
function valuesAt(document: unknown, key: string): unknown[] {
  let current: unknown[] = [document];
  for (const part of key.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (part === '*') next.push(...Object.values(record));
      else if (Object.hasOwn(record, part)) next.push(record[part]);
    }
    current = next;
  }
  return current;
}

function matches(value: unknown, weakening: UserWeakening): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (weakening.values === 'any') return true;
  return weakening.values.some((wanted) => String(wanted) === String(value));
}

/** Policy parts the user policy covers: depcurfew writes those keys itself, so drift reports them, not this rule. */
function coveredPurposes(policy: ResolvedPolicy | undefined): Set<UserSettingPurpose> {
  const covered = new Set<UserSettingPurpose>();
  if (policy?.cooldown !== undefined) for (const purpose of ['cooldown', 'cooldownExclude', 'cooldownStrict'] as const) covered.add(purpose);
  if (policy?.installScripts !== undefined) for (const purpose of ['scriptsAllow', 'scriptsStrict', 'buildsDeny', 'buildsAllow'] as const) covered.add(purpose);
  if (policy?.sources !== undefined) for (const purpose of ['sourceGit', 'sourceRemote', 'sourceFile', 'sourceDirectory', 'sourcesExotic'] as const) covered.add(purpose);
  return covered;
}

interface Located {
  line?: number;
  value: unknown;
}

/** Values of a key in a user file, with their lines where the format tells them; keys of depcurfew's block are skipped. */
function lookUp(file: UserFile, text: string, key: string): Located[] {
  if (file.format === 'ini') {
    return iniLines(text)
      .filter((entry) => !entry.managed && entry.key.replace(/\[\]$/u, '') === key)
      .map((entry) => ({ line: entry.line, value: entry.value }));
  }
  if (file.format === 'yaml') {
    try {
      return valuesAt(parseYaml(text), key).map((value) => ({ value }));
    } catch {
      return [];
    }
  }
  try {
    const document = parseToml(text);
    return valuesAt(document.root, key).map((value) => ({ value, ...lineOf(document, key) }));
  } catch {
    return [];
  }
}

function lineOf(document: ReturnType<typeof parseToml>, key: string): { line?: number } {
  if (key.includes('*')) return {};
  const line = document.lineOf(key.split('.'));
  return line === undefined ? {} : { line };
}

function variableValue(environment: UserEnvironment, name: string, anyCase: boolean): string | undefined {
  if (!anyCase) return environment.env[name];
  const key = Object.keys(environment.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : environment.env[key];
}

export interface UserDoctorOptions {
  environment: UserEnvironment;
  versions?: Partial<Record<ToolId, Version>>;
  tools?: readonly ToolKnowledge[];
}

export function runUserDoctor(options: UserDoctorOptions): DoctorReport & { policyFile: string } {
  const { environment } = options;
  const tools = options.tools ?? knowledgeBase;
  const findings: Finding[] = [];
  const notices: Notice[] = [];
  let policy: ResolvedPolicy | undefined;
  let status: DoctorReport['policy'] = 'valid';
  let policyFile = '';
  try {
    const loaded = loadUserPolicy(environment);
    policy = loaded.policy;
    policyFile = loaded.shown;
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    status = error.code === 'policy-missing' ? 'missing' : 'invalid';
    notices.push({ message: `${error.message}: only the checks that do not need a user policy ran` });
  }

  if (policy !== undefined) {
    const planned = planUserApply(policy, { environment, ...(options.versions === undefined ? {} : { versions: options.versions }), tools });
    for (const change of planned.report.changes) {
      findings.push({
        rule: 'user-config-drift',
        level: 'warning',
        location: { file: change.file },
        message: change.before === null ? `${change.file} does not exist, so the user policy is not applied there` : `${change.file} does not match the user policy (${policyFile})`,
        fix: 'Run depcurfew apply --user --dry-run to see the difference, then depcurfew apply --user',
      });
    }
    for (const warning of planned.report.warningDetails) {
      if (warning.code === 'version-unknown' || warning.code === 'no-user-config' || warning.code === 'nothing-to-configure') notices.push({ message: warning.message });
    }
    for (const error of planned.report.errors) notices.push({ message: error });
  }

  const covered = coveredPurposes(policy);
  for (const tool of tools) {
    if (tool.kind !== 'package-manager' || tool.user === undefined) continue;
    if (findExecutable(tool.id, environment) === undefined) continue;
    const version = options.versions?.[tool.id] ?? installedVersion(tool.id, ecosystemOfTool(tool), environment)?.version;
    const file = userFileFor(tool, version);
    const path = file === null ? undefined : userFilePath(file, environment);
    const text = path === undefined ? undefined : readFile(path);
    if (file !== null && path !== undefined && text !== undefined) {
      const managedKeys = new Set((evidenceOf(tool.user.settings)[0]?.value ?? []).filter((setting) => covered.has(setting.purpose)).map((setting) => setting.key));
      const shown = shownPath(path, environment);
      for (const weakening of evidenceOf(tool.user.weakening)[0]?.value ?? []) {
        if (managedKeys.has(weakening.key)) continue;
        for (const found of lookUp(file, text, weakening.key)) {
          if (!matches(found.value, weakening)) continue;
          findings.push({
            rule: 'user-config-weakens',
            level: 'warning',
            location: { file: shown, ...(found.line === undefined ? {} : { line: found.line }) },
            message: `${weakening.key} = ${JSON.stringify(found.value)} in ${shown} ${weakening.effect} (${tool.name}), in every project that does not set it itself`,
            fix: `Remove ${weakening.key} from ${shown}${policy === undefined ? '' : ', or put what you need into the user policy and run depcurfew apply --user'}`,
          });
        }
      }
    }
    for (const variable of evidenceOf(tool.user.variables)[0]?.value ?? []) {
      const value = variableValue(environment, variable.name, variable.anyCase === true);
      if (value === undefined || value === '') continue;
      if (variable.values !== 'any' && !variable.values.some((wanted) => wanted.toLowerCase() === value.trim().toLowerCase())) continue;
      if (findings.some((finding) => finding.rule === 'user-environment-overrides' && finding.message.startsWith(`${variable.name}=`))) continue;
      findings.push({
        rule: 'user-environment-overrides',
        level: 'warning',
        location: { file: 'environment' },
        message: `${variable.name}=${value} is set in the environment (${tool.name}): ${variable.effect}`,
        fix: `Unset ${variable.name} in your shell profile or CI settings, or set it to a value the policy allows`,
      });
    }
  }
  return { schemaVersion: 1, policy: status, findings, notices, policyFile };
}
