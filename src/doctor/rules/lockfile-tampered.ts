// lockfile-tampered (decision D-204): composer.lock gives a package a transport option that Composer calls as a PHP
// function while it downloads the package (extra.transportCallables): prevent_url_access_callable, with the URL, which
// lets an edited composer.lock run a command (GHSA-jhfp-4ppm-crmm), and prevent_ip_access_callable, with the IP address
// of the server. Composer 2.11.2 no longer takes them from composer.lock. A repository of composer.json can give them
// too, in the options of a Composer or VCS repository or in a package a package repository defines, and Composer copies
// them into composer.lock from there. A fact of the files, not a difference from a policy: an error with or without
// depcurfew.json and in the projects init would list, whatever the Composer version, which depcurfew cannot tell. The
// lockfile is read once with the other lockfile rules (LockEntry.transportCallables); its general id leaves room for
// other signs that a lockfile was edited. The Composer versions and the advisory of every text come from the fact.
import { composer } from '../../knowledge/composer.ts';
import type { ComposerTransportCallablesKnowledge, ToolKnowledge } from '../../knowledge/types.ts';
import { COMPOSER_MANIFEST, isComposerName, repositoryCallables, repositoryTypes, transportCallablesOf, type RepositoryCallable } from '../composer.ts';
import { readLockfiles, type Lockfile, type LockEntry } from '../lockfiles.ts';
import type { Repository } from '../../detect/repository.ts';
import type { Rule, RuleContext, RuleScope } from '../types.ts';

const RULE = 'lockfile-tampered';

type CallableKey = ComposerTransportCallablesKnowledge['keys'][number];

/** The key of the fact; a key the fact does not know does not reach here. */
function keyOf(fact: ComposerTransportCallablesKnowledge, key: string): CallableKey {
  return fact.keys.find((entry) => entry.key === key) ?? { key, from: '', to: '', argument: 'a value' };
}

/**
 * What Composer does with a key: "which Composer 2.7.3 to 2.11.1 call as a PHP function, when it names one, with … of
 * each download …". Composer calls the value only when it is callable (CurlDownloader), while the rule reports any
 * value but null. `advisory`: name the advisory of the key, which concerns the copy in composer.lock.
 */
function calledWith(entry: CallableKey, verb: string, what: string, advisory: boolean): string {
  const runs = !advisory || entry.advisory === undefined ? '' : `, and a function such as system there runs a command (${entry.advisory})`;
  return `which Composer ${entry.from} to ${entry.to} ${verb} as a PHP function, when it names one, with ${entry.argument} of each download ${what}${runs}`;
}

/** The texts of the rule, from the fact: which keys, from which Composer, and which Composer no longer takes them. */
export function lockfileTamperedTexts(fact: ComposerTransportCallablesKnowledge | undefined): { summary: string; description: string; help: string } {
  const [url, ip] = fact?.keys ?? [];
  const remove = 'remove the transport option from composer.lock and composer.json, or restore them from before the change, and find out who added it.';
  if (fact === undefined || url === undefined || ip === undefined) {
    return {
      summary: 'A package of composer.lock, or a repository of composer.json, has a transport option that Composer calls as a PHP function while downloading.',
      description: 'composer.lock gives a package a transport option that Composer calls as a PHP function while downloading.',
      help: `Before any composer install or update, ${remove}`,
    };
  }
  const advisory = url.advisory === undefined ? '' : `${url.advisory}, `;
  return {
    summary: `A package of composer.lock, or a repository of composer.json, has a transport option that Composer calls as a PHP function while downloading (${advisory}fixed in Composer ${fact.dropped}).`,
    description: [
      `Composer ${url.from} to ${url.to} take ${url.key} from the ${fact.lockField} of a package in composer.lock and, when it names a PHP function, call it with ${url.argument} of each download of the package, so an edited composer.lock can run a command during composer install${url.advisory === undefined ? '' : ` (${url.advisory})`}.`,
      `Composer ${ip.from} to ${ip.to} do the same with ${ip.key} and ${ip.argument}.`,
      `Composer ${fact.dropped} no longer takes them from composer.lock.`,
      `composer.json can set them too: in the ${fact.repositoryField} of a Composer or VCS repository, which Composer uses for its downloads and copies into composer.lock for the packages a Composer repository serves from its own URL, and in the ${fact.lockField} of a package a package repository defines, which it copies there too.`,
      'The rule checks the packages and packages-dev of composer.lock and the repositories of composer.json whatever the Composer version, which depcurfew cannot tell, and leaves other transport options, such as symlink of a path repository, alone.',
    ].join(' '),
    help: `Use Composer ${fact.dropped} or later before any composer install or update, then ${remove}`,
  };
}

const TEXTS = lockfileTamperedTexts(transportCallablesOf(composer));

/**
 * Forgets the warnings that reading `file` added to the repository since `since`. Without a policy unreadable-config
 * would make them errors, while a lockfile that does not parse is a note against the default policy, as the other
 * lockfiles are, which only the rules that need a policy read.
 */
function forgetWarnings(repository: Repository, since: number, file: string): void {
  for (let index = repository.warnings.length - 1; index >= since; index -= 1) {
    if (repository.warnings[index]?.files.includes(file) === true) repository.warnings.splice(index, 1);
  }
}

/** Composer is found with a composer.lock. */
function hasComposerLock(scope: RuleScope): boolean {
  return scope.detection.packageManagers.some((manager) => manager.supported && manager.id === 'composer' && manager.evidence.some((evidence) => evidence.kind === 'lockfile'));
}

/** A package of composer.lock as a fix names it: its name when it is a Composer package name, else its line. */
function packageInFix(lockfile: Lockfile, entry: LockEntry, line: number | undefined): string {
  if (isComposerName(entry.name)) return entry.name;
  return line === undefined ? `the package ${JSON.stringify(entry.name)}` : `the package at line ${line} of ${lockfile.file}`;
}

function reportLockfile(context: RuleContext, fact: ComposerTransportCallablesKnowledge, lockfile: Lockfile): void {
  for (const entry of lockfile.entries) {
    for (const key of entry.transportCallables ?? []) {
      const line = lockfile.lineOf(entry);
      context.report({
        location: line === undefined ? { file: lockfile.file } : { file: lockfile.file, line },
        message: `${lockfile.file} gives ${entry.name} the transport option ${key}, ${calledWith(keyOf(fact, key), `take from ${lockfile.file} and call`, 'of the package', true)}; Composer ${fact.dropped} no longer takes it from ${lockfile.file}`,
        fix: `Use Composer ${fact.dropped} or later before any composer install or update on this lockfile; then remove ${key} from the ${fact.lockField} of ${packageInFix(lockfile, entry, line)} in ${lockfile.file}, or restore ${lockfile.file} from before the change, and find out who changed it`,
      });
    }
  }
}

function reportManifest(context: RuleContext, tool: ToolKnowledge, fact: ComposerTransportCallablesKnowledge, found: RepositoryCallable): void {
  const repository = `repositories[${String(found.repository)}]`;
  const entry = keyOf(fact, found.key);
  const fix = (where: string) =>
    `Use Composer ${fact.dropped} or later before any composer install or update in this project; then remove ${found.key} from ${where} in ${COMPOSER_MANIFEST} and from every entry of composer.lock that has it, and find out who added it`;
  const location = found.line === undefined ? { file: COMPOSER_MANIFEST } : { file: COMPOSER_MANIFEST, line: found.line };
  if (found.package !== undefined) {
    const name = found.package === '' ? 'a package' : found.package;
    const named = isComposerName(found.package.toLowerCase()) ? found.package : 'the package';
    context.report({
      location,
      message: `${COMPOSER_MANIFEST} gives ${name}, a package that the package repository ${repository} defines, the transport option ${found.key}, ${calledWith(entry, 'call', 'of the package', false)}; Composer copies the ${fact.lockField} of such a package into composer.lock`,
      fix: fix(`the ${fact.lockField} of ${named} in ${repository}`),
    });
    return;
  }
  const what = found.url === undefined ? `a ${found.type} repository` : `the ${found.type} repository ${found.url}`;
  // Composer gives the packages a Composer repository serves from its own URL its options, which composer.lock then
  // records (ComposerRepository::isOwnDistUrl).
  const copied = repositoryTypes(tool).registry.includes(found.type) ? `; Composer copies the ${fact.repositoryField} of a Composer repository into composer.lock for the packages it serves from its own URL` : '';
  context.report({
    location,
    message: `${COMPOSER_MANIFEST} gives ${what} (${repository}) the transport option ${found.key} in its ${fact.repositoryField}, ${calledWith(entry, 'call', 'from that repository', false)}${copied}`,
    fix: fix(`the ${fact.repositoryField} of ${repository}`),
  });
}

export const lockfileTampered: Rule = {
  id: RULE,
  checks: 'No package of composer.lock and no repository of composer.json has a transport option that Composer calls as a PHP function',
  summary: TEXTS.summary,
  description: TEXTS.description,
  help: TEXTS.help,
  level: 'error',
  requiresPolicy: false,
  // A transport option Composer calls is a fact of the files: without depcurfew.json it is an error in the projects init
  // would list too, as known-malicious is (decision D-161).
  alsoInComparedProjects: true,
  applies: hasComposerLock,
  check(context) {
    const workspaces = context.detection.workspaces?.packages ?? [];
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported && entry.id === 'composer')) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      const fact = tool === undefined ? undefined : transportCallablesOf(tool);
      if (tool === undefined || fact === undefined) continue;
      for (const found of repositoryCallables(context.repository, tool)) reportManifest(context, tool, fact, found);
      // Without a policy no other rule reads composer.lock, and one that does not parse stays a note against the
      // default policy, as before this rule and as another lockfile is: the rule says only that it could not check it.
      const quiet = context.policy === undefined;
      const known = context.repository.warnings.length;
      for (const result of readLockfiles(context.repository, manager, tool, workspaces, context.tools)) {
        if (result.ok) reportLockfile(context, fact, result.lockfile);
        else {
          if (quiet && result.unreadable) forgetWarnings(context.repository, known, result.file);
          // With a policy an unreadable lockfile is an error of unreadable-config.
          if (quiet || !result.unreadable) context.notice(`${RULE} could not check ${result.file}: ${result.reason}`, result.file);
        }
      }
    }
  },
};
