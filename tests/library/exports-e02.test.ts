// The contract of the library (E02, decision D-197 point 3), read from the published files dist/index.js and
// dist/index.d.ts. Semantic versioning covers getVersion, loadPolicy, checkSpecs and PopularNames with the shapes of
// their options and results: a minor or patch release adds optional options and result fields and new values of codes
// and kinds, and never removes or renames one, makes an option required or changes the levels of a finding.
//
// The snapshots of every export change with each export added or removed: a removed or renamed export is a breaking
// change, and an added one goes into CHANGELOG under Library.
import { describe, expect, it } from 'vitest';
import { builtLibrary, LibraryTypes } from '../support/library-types.ts';

const VALUES = [
  'APPLY_ERRORS', 'APPLY_WARNINGS', 'ApplyWriteError', 'DEFAULT_POLICY', 'EXIT_FAILURE', 'EXIT_OK', 'EXIT_USAGE', 'LocalOsvData', 'POLICY_FILE', 'PolicyError', 'PopularNames', 'RULES', 'SCHEMA_URL',
  'applyProject', 'botDuration', 'checkSpec', 'checkSpecs', 'convertCooldown', 'convertMinutes', 'countLevels', 'defaultOsvData', 'defaultPopularNames', 'detectProject', 'formatDuration', 'formatIssue', 'getVersion', 'loadPolicy', 'parseDuration', 'parsePolicy', 'planApply', 'planRepository', 'queryOsv', 'renderPolicy', 'renderText', 'run', 'runDoctor', 'runDoctorWithLocalOsv', 'runDoctorWithOsv', 'scanCommandLine', 'toDurationString', 'toSarif', 'unifiedDiff', 'updateOsvData', 'validatePolicy', 'warningText',
];

const TYPES = [
  'ApplyErrorCode', 'ApplyProblem', 'ApplyReport', 'ApplyWarning', 'ApplyWarningCode', 'CheckFinding', 'CheckOptions', 'CheckRequest', 'CliIo', 'CommandDirectory', 'CommandScan', 'Converted', 'CooldownConversion', 'DefaultPopularNames', 'DetectOptions', 'Detection', 'DetectionWarning', 'DoctorReport', 'Duration', 'DurationResult', 'DurationStringUnit', 'FetchLike', 'FileChange', 'Finding', 'FindingCode', 'InstallRequest', 'KnownDirectory', 'Level', 'LocalOsvDataOptions', 'Location', 'Notice', 'NumericDelayUnit', 'OsvDataLimits', 'OsvDataState', 'OsvOptions', 'OsvPackage', 'OsvSource', 'OsvUpdateOptions', 'OsvUpdateResult', 'OsvVerdict', 'PackageManagerInfo', 'PackageReport', 'PlanOptions', 'Policy', 'PolicyIssue', 'PolicyResult', 'ProjectProblem', 'ResolvedPolicy', 'Rule', 'ScanOptions', 'Snippet', 'SpecKind', 'VersionDeclaration',
];

const types = new LibraryTypes();

describe('what the package exports (E02)', () => {
  it('exports these values from dist/index.js', async () => {
    const library = await builtLibrary();
    expect(Object.keys(library).sort()).toEqual([...VALUES].sort());
  });

  it('exports these values and types from dist/index.d.ts', () => {
    expect(types.names()).toEqual([...VALUES, ...TYPES].sort());
  });

  it('names the types of the options and results of checkSpecs, so that a program can write them', () => {
    for (const name of ['CheckRequest', 'CheckOptions', 'FetchLike', 'SpecKind', 'PackageReport', 'CheckFinding', 'FindingCode']) expect(types.names(), name).toContain(name);
  });
});

describe('the exports semantic versioning covers (decision D-197)', () => {
  it('keeps the signatures of getVersion, loadPolicy, checkSpecs, checkSpec and PopularNames', () => {
    expect(types.signatures('getVersion')).toEqual(['(): string']);
    expect(types.signatures('loadPolicy')).toEqual(['(root: string): ResolvedPolicy']);
    expect(types.signatures('checkSpecs')).toEqual(['(specs: readonly (string | CheckRequest)[], options: CheckOptions): Promise<PackageReport[]>']);
    expect(types.signatures('checkSpec')).toEqual(['(request: string | CheckRequest, options: CheckOptions): Promise<PackageReport>']);
    expect(types.signatures('PopularNames')).toEqual(['(names: readonly string[]): PopularNames']);
  });

  it('requires no option of checkSpecs beyond the five it has always required, and keeps every optional one', () => {
    const options = types.properties('CheckOptions');
    expect(options.filter((name) => !name.endsWith('?'))).toEqual(['fetch', 'now', 'policy', 'popular', 'registry']);
    const optional = ['composerStability?', 'defaultTag?', 'index?', 'installDirectory?', 'lookups?', 'popularPython?', 'projectRoot?', 'scopeRegistries?', 'scopeWhere?', 'scriptBodies?', 'signal?', 'skipLookup?'];
    expect(options).toEqual(expect.arrayContaining(optional));
    const request = types.properties('CheckRequest');
    expect(request.filter((name) => !name.endsWith('?'))).toEqual(['spec']);
    expect(request).toEqual(expect.arrayContaining(['tool?', 'tag?', 'ignoresConfigTag?', 'prereleases?', 'buildFromSource?', 'workspacesOption?', 'readsManifest?', 'fromManifest?', 'composerCommand?', 'rootStability?', 'linked?', 'optionValue?']));
  });

  it('keeps every field of a report and a finding, required ones required', () => {
    const report = types.properties('PackageReport');
    expect(report).toEqual(expect.arrayContaining(['spec', 'kind', 'findings', 'name?', 'version?', 'publishedAt?', 'latest?', 'tag?', 'prereleases?', 'buildFromSource?']));
    expect(report.filter((name) => !name.endsWith('?'))).toEqual(['findings', 'kind', 'spec']);
    const finding = types.properties('CheckFinding');
    expect(finding).toEqual(expect.arrayContaining(['code', 'fix', 'level', 'message', 'source?']));
    expect(finding.filter((name) => !name.endsWith('?'))).toEqual(['code', 'fix', 'level', 'message']);
  });

  it('gives a finding the level error or warning, nothing else', () => {
    expect(types.literals('CheckFinding', 'level')).toEqual(['error', 'warning']);
  });

  it('only adds codes and kinds', () => {
    const codes = ['archived', 'deprecated', 'forbidden-source', 'insecure-registry', 'install-scripts', 'invalid-spec', 'known-malicious', 'no-version', 'not-found', 'quarantined', 'similar-name', 'too-young', 'unchecked-source', 'unverified', 'yanked'];
    expect(types.literals('FindingCode')).toEqual(expect.arrayContaining(codes));
    expect(types.literals('CheckFinding', 'code')).toEqual(types.literals('FindingCode'));
    const kinds = ['directory', 'file', 'git', 'other', 'registry', 'remoteTarball', 'workspace'];
    expect(types.literals('SpecKind')).toEqual(expect.arrayContaining(kinds));
    expect(types.literals('PackageReport', 'kind')).toEqual([...types.literals('SpecKind'), 'invalid'].sort());
  });
});
