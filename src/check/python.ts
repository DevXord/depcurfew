// `depcurfew check pypi:<requirement>`: the Python side of check. A package from the index is looked up on the index's
// project page: whether it exists, the project status (quarantined, archived, deprecated), the version the
// requirement picks (PEP 440, yanked versions left out unless pinned), the age of its newest file against the
// cooldown, and whether it has a wheel at all (without one, installing builds it from source, which runs its build
// code: the Python counterpart of install scripts, D-065). Look-alike names are compared with popular projects after
// normalization. Git, URL and path requirements are checked against the policy's sources section only.
import { values } from '../apply/facts.ts';
import { matchesPattern } from '../doctor/allow-lists.ts';
import { formatMinutes } from '../doctor/durations.ts';
import { environment } from '../knowledge/environment.ts';
import { policyFor } from '../policy/ecosystem.ts';
import { PYPI_PREFIX } from '../policy/package-pattern.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import {
  CHECK_BY_HAND,
  describeAge,
  insecureFinding,
  PYTHON_SOURCE_LABELS,
  sourceFindings,
  type CheckFinding,
  type CheckOptions,
  type CheckRequest,
  type PackageReport,
} from './findings.ts';
import { matchesSpecifiers, pickVersion, pinsVersion, type Clause } from './pep440.ts';
import { defaultIndex, fetchProject, type PypiFile, type PypiProject } from './pypi.ts';
import { parsePythonSpec } from './python-spec.ts';

/** Whether a spec names a Python package: it starts with pypi:. */
export function isPythonSpec(raw: string): boolean {
  return raw.trim().startsWith(PYPI_PREFIX);
}

function statuses() {
  return values(environment.pypiIndex.projectStatus)[0] ?? { blocked: [], warned: [] };
}

/** The files of a version that an installer may pick: yanked files only when the requirement pins the version. */
function usable(files: readonly PypiFile[], pinned: boolean): readonly PypiFile[] {
  const current = files.filter((file) => file.yanked === false);
  return current.length > 0 || !pinned ? current : files;
}

function times(files: readonly PypiFile[]): number[] {
  return files.map((file) => Date.parse(file.uploadedAt ?? '')).filter((time) => !Number.isNaN(time));
}

function earliest(files: readonly PypiFile[]): PypiFile | undefined {
  return [...files].sort((a, b) => Date.parse(a.uploadedAt ?? '') - Date.parse(b.uploadedAt ?? ''))[0];
}

type Chosen = Omit<CheckRequest, 'spec'>;

/** Whether a policy pattern matches a Python name: both are compared after normalization (PEP 503), as doctor does. */
function matchesName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(name, normalizePythonName(pattern)));
}

/** Versions with files an installer may pick for these clauses. */
function candidates(project: PypiProject, clauses: readonly Clause[]): string[] {
  const pinned = pinsVersion(clauses);
  return [...project.releases].filter(([, files]) => usable(files, pinned).length > 0).map(([version]) => version);
}

/** The newest version the clauses allow whose files are all older than the cutoff, to suggest instead. */
function oldEnough(project: PypiProject, clauses: readonly Clause[], cutoff: number, prereleases: Chosen['prereleases']): string | undefined {
  const pinned = pinsVersion(clauses);
  const versions = candidates(project, clauses).filter((version) => {
    const files = usable(project.releases.get(version) ?? [], pinned);
    const known = times(files);
    return known.length === files.length && known.every((time) => time <= cutoff);
  });
  return pickVersion(versions, clauses, prereleases);
}

function statusFindings(project: PypiProject, label: string): CheckFinding[] {
  const reason = project.statusReason === undefined || project.statusReason.trim() === '' ? '' : `: ${project.statusReason.trim()}`;
  if (statuses().blocked.includes(project.status)) {
    return [
      {
        level: 'error',
        code: 'quarantined',
        message: `${label} is quarantined by the index, which considers it unsafe${reason}`,
        fix: `Do not install ${label}; find another package that does what you need`,
      },
    ];
  }
  if (!statuses().warned.includes(project.status)) return [];
  if (project.status === 'archived') {
    return [{ level: 'warning', code: 'archived', message: `${label} is archived and gets no more releases${reason}`, fix: 'Prefer a maintained package; an archived one gets no security fixes' }];
  }
  return [{ level: 'warning', code: 'deprecated', message: `${label} is ${project.status}${reason}`, fix: 'Pick a package that is not deprecated; the reason often names one' }];
}

async function checkIndexPackage(report: PackageReport, name: string, clauses: readonly Clause[], selector: string, options: CheckOptions, chosen: Chosen): Promise<void> {
  const policy = policyFor(options.policy, 'pypi');
  const label = `${PYPI_PREFIX}${name}`;
  const index = options.index ?? defaultIndex();
  const add = (finding: CheckFinding) => report.findings.push(finding);
  const insecure = insecureFinding(index, 'index');
  if (insecure !== undefined) add(insecure);
  const similar = options.popularPython?.similar(name);
  if (similar !== undefined) {
    const how = similar.reason === 'edit' ? 'differs by a letter or two from' : 'differs only in separators from';
    add({
      level: 'error',
      code: 'similar-name',
      message: `the name ${how} the popular package ${PYPI_PREFIX}${similar.match}; make sure it is the package you want`,
      fix: `Install ${PYPI_PREFIX}${similar.match} if that is what you meant; otherwise check that ${label} is the package its documentation names`,
    });
  }

  const lookup = await fetchProject(name, { index, fetch: options.fetch, signal: options.signal });
  if (lookup.status === 'not-found') {
    add({
      level: 'error',
      code: 'not-found',
      message: `${label} does not exist in ${index}; the name may be mistyped or made up`,
      fix: 'Check the spelling against the documentation of the package you want; do not install a name that was guessed',
    });
    return;
  }
  if (lookup.status === 'error') {
    add({ level: 'error', code: 'unverified', message: `it cannot be checked: ${lookup.reason}`, fix: lookup.fix ?? 'Run depcurfew check again when the index is reachable' });
    return;
  }
  const project = lookup.project;
  report.findings.push(...statusFindings(project, label));
  if (statuses().blocked.includes(project.status)) return;

  const latest = pickVersion(candidates(project, []), []);
  if (latest !== undefined) {
    const first = earliest(usable(project.releases.get(latest) ?? [], false));
    report.latest = first?.uploadedAt === undefined ? { version: latest } : { version: latest, publishedAt: first.uploadedAt };
  }
  const pinned = pinsVersion(clauses);
  const version = pickVersion(candidates(project, clauses), clauses, chosen.prereleases);
  if (version === undefined) {
    const yankedOnly = [...project.releases.keys()].some((candidate) => matchesSpecifiers(candidate, clauses));
    add({
      level: 'error',
      code: 'no-version',
      message: `no version of ${label} matches "${selector || 'any version'}"${yankedOnly ? ' (only yanked versions do)' : ''}`,
      fix: latest === undefined ? `Pick a version of ${label} that exists` : `Pick a version of ${label} that exists, such as ${label}==${latest}`,
    });
    return;
  }
  report.version = version;
  const files = usable(project.releases.get(version) ?? [], pinned);
  const first = earliest(files);
  if (first?.uploadedAt !== undefined) report.publishedAt = first.uploadedAt;
  const versionLabel = `${label} ${version}`;

  const yanked = files.find((file) => file.yanked !== false);
  if (yanked !== undefined && yanked.yanked !== false) {
    add({
      level: 'warning',
      code: 'yanked',
      message: `${versionLabel} is yanked${yanked.yanked.trim() === '' ? '' : `: ${yanked.yanked.trim()}`}`,
      fix: `Pick a version of ${label} that is not yanked${latest === undefined ? '' : `, such as ${label}==${latest}`}`,
    });
  }

  const cooldown = policy.cooldown;
  if (cooldown !== undefined && !matchesName(name, cooldown.exclude)) {
    const known = times(files);
    if (known.length < files.length) {
      add({
        level: 'error',
        code: 'unverified',
        message: `the index gives no upload time for a file of ${versionLabel}, so its age cannot be checked`,
        fix: `Check when ${versionLabel} was published before installing it, or pin a version whose files the index dates`,
      });
    } else {
      // An installer may pick any file of the version, so the newest one counts: files can be added to a release later.
      const newest = Math.max(...known);
      const age = (options.now.getTime() - newest) / 60000;
      if (age < cooldown.minimum.minutes) {
        const firstAge = (options.now.getTime() - Math.min(...known)) / 60000;
        const newestFile = files.find((file) => Date.parse(file.uploadedAt ?? '') === newest);
        const published =
          firstAge >= cooldown.minimum.minutes && newestFile !== undefined
            ? `was published ${describeAge(firstAge)} ago, but its file ${newestFile.filename} was uploaded ${describeAge(age)} ago`
            : `was published ${describeAge(age)} ago`;
        const instead = oldEnough(project, clauses, options.now.getTime() - cooldown.minimum.minutes * 60000, chosen.prereleases);
        add({
          level: 'error',
          code: 'too-young',
          message: `${versionLabel} ${published}; depcurfew.json requires ${formatMinutes(cooldown.minimum.minutes)}${instead === undefined || instead === version ? '' : ` (${label} ${instead} is old enough)`}`,
          fix: `${instead === undefined || instead === version ? 'Wait' : `Install ${label}==${instead} instead, or wait`} until ${versionLabel} is ${formatMinutes(cooldown.minimum.minutes)} old`,
        });
      }
    }
  }

  const allowed = matchesName(name, policy.installScripts?.allow ?? []);
  const denied = matchesName(name, policy.installScripts?.deny ?? []);
  const sdists = files.filter((file) => file.kind === 'sdist');
  const sdistOnly = sdists.length > 0 && sdists.length === files.length;
  // Without a wheel, or with wheels refused by the command (--no-binary), the installer builds the source distribution.
  const builds = sdists.length > 0 && (sdistOnly || chosen.buildFromSource === true);
  if (policy.installScripts?.default !== 'deny' || allowed || !builds) return;
  if (denied && sdistOnly && chosen.buildFromSource !== true) {
    // Denied on purpose (decision D-085): not built from source, so where the tool blocks building, it cannot be installed.
    add({
      level: 'warning',
      code: 'install-scripts',
      message: `${versionLabel} has no wheel, only a source distribution, and depcurfew.json denies building it (installScripts.deny), so installing it fails where building from source is blocked`,
      fix: `Pick a version or package with wheels, or move ${label} from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its build`,
    });
    return;
  }
  const why = sdistOnly ? 'has no wheel, only a source distribution, so installing it builds it from source' : 'is built from its source distribution, because the command refuses wheels (no-binary),';
  const instead = sdistOnly ? 'Pick a version or package with wheels' : 'Install it from a wheel (leave out --no-binary)';
  add({
    level: 'error',
    code: 'install-scripts',
    message: `${versionLabel} ${why} and runs its build code, which depcurfew.json ${denied ? 'denies (installScripts.deny)' : 'does not allow (installScripts)'}`,
    fix: denied
      ? `${instead}, or move ${label} from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its build`
      : `${instead}, or add ${label} to installScripts.allow in depcurfew.json if you trust its build`,
  });
}

export async function checkPythonSpec(raw: string, options: CheckOptions, chosen: Chosen = {}): Promise<PackageReport> {
  const spec = parsePythonSpec(raw.trim().slice(PYPI_PREFIX.length));
  if (spec === undefined) {
    const finding: CheckFinding = {
      level: 'error',
      code: 'invalid-spec',
      message: `"${raw}" is not a Python package spec`,
      fix: `Write it as ${PYPI_PREFIX}name, ${PYPI_PREFIX}name==version or ${PYPI_PREFIX}name>=version`,
    };
    return { spec: raw, kind: 'invalid', findings: [finding] };
  }
  const report: PackageReport = {
    spec: raw,
    kind: spec.kind,
    ...(chosen.prereleases === undefined ? {} : { prereleases: chosen.prereleases }),
    ...(chosen.buildFromSource === undefined ? {} : { buildFromSource: chosen.buildFromSource }),
    findings: [],
  };
  if (spec.name !== undefined) report.name = `${PYPI_PREFIX}${spec.name}`;
  if (spec.kind === 'workspace') {
    report.findings.push({
      level: 'warning',
      code: 'unchecked-source',
      message: 'it is the project itself; depcurfew looks up index packages only',
      fix: 'Nothing to do if this is the project you work on',
    });
  } else if (spec.kind === 'other') {
    report.findings.push({ level: 'error', code: 'unverified', message: `it is not looked up: ${spec.reason ?? 'unknown source'}`, fix: CHECK_BY_HAND });
  } else if (spec.kind !== 'registry') {
    report.findings.push(...sourceFindings({}, spec.kind, options.policy, PYTHON_SOURCE_LABELS));
  } else if (spec.name !== undefined) {
    const selector = raw.trim().slice(PYPI_PREFIX.length).split(';', 1)[0]?.replace(/^[A-Za-z0-9._-]+\s*(\[[^\]]*\])?\s*/u, '').trim() ?? '';
    await checkIndexPackage(report, spec.name, spec.clauses ?? [], selector, options, chosen);
  }
  return report;
}
