// Facts about OSV.dev, which `--osv` of check, the Claude Code hook, depcurfew mcp and doctor asks about known malicious
// package versions (decision D-129), and whose public export depcurfew osv update downloads (decision D-150). osv.dev
// is built from docs/ in google/osv.dev; the schema and its list of record prefixes and ecosystems are in
// ossf/osv-schema; the malicious-package records come from ossf/malicious-packages.
import { verifiedOn } from './define.ts';
import type { OsvKnowledge } from './types.ts';

const { verified } = verifiedOn('2026-11-02');
const { verified: verifiedLater } = verifiedOn('2026-11-03');

const OSV_DOCS = 'https://github.com/google/osv.dev/blob/master/docs';
const OSV_SCHEMA = 'https://github.com/ossf/osv-schema/blob/main/docs/schema.md';
/** The Go code of the API and the workers of OSV.dev, at the commit that was read. */
const OSV_GO = 'https://github.com/google/osv.dev/blob/b7449847246af793439d06284d340af40cdae854/go';

export const osv: OsvKnowledge = {
  api: verified(
    {
      url: 'https://api.osv.dev',
      queryBatchPath: '/v1/querybatch',
      vulnerabilityPath: '/v1/vulns/{id}',
      recordPage: 'https://osv.dev/vulnerability/{id}',
      queriesField: 'queries',
      resultsField: 'results',
      vulnsField: 'vulns',
      idField: 'id',
      nextPageTokenField: 'next_page_token',
      pageTokenField: 'page_token',
      maxQueriesPerBatch: 1000,
    },
    `${OSV_DOCS}/api/post-v1-querybatch.md`,
    'POST /v1/querybatch takes {"queries": [...]}, each query as for POST /v1/query: a package by name and ecosystem with a top-level version, or by purl (a version in both places is a 400). It "Returns vulnerability ids and modified field only. The response ordering will be guaranteed to match the input": {"results": [{"vulns": [{"id", "modified"}], "next_page_token"?}]}. A result with more pages has next_page_token; the next request sends page_token only for those queries, and rarely a result holds only a token, so the caller keeps asking until no token comes back. The response is the JSON of v1BatchVulnerabilityList (docs/osv_service_v1.swagger.json), where an empty list is left out. "MaxQueriesPerQueryBatchRequest is a limit set in osv.dev\'s API, so is not configurable" = 1000 (bindings/go/osvdev/osvdev.go, with DefaultBaseURL https://api.osv.dev). A record\'s page is https://osv.dev/vulnerability/<ID> (docs/faq.md); GET /v1/vulns/{id} returns the record (docs/api/get-v1-vulns.md). Requests are case-sensitive ("use \'PyPI\' instead of \'pypi\'"), and PyPI names are matched after PEP 503 normalization (docs/api/post-v1-query.md). api.osv.dev could not be reached from the machine that read these sources.',
  ),
  paging: verified(
    { perQuery: 1000, perBatch: 3000 },
    `${OSV_DOCS}/api/post-v1-querybatch.md#pagination`,
    'Pagination happens when "An individual query within the queryset returns more than 1,000 vulnerabilities" or "The entire queryset returns more than 3,000 vulnerabilities total"; "These numbers can vary slightly because of threading and the page size may change in the future."',
  ),
  ids: verified(
    { pattern: '^[a-zA-Z0-9:_.-]+$' },
    'https://github.com/ossf/osv-schema/blob/v1.9.2/docs/schema.md#character-set-constraints',
    'Version 1.9.2 (October 13, 2026) of the OSV schema: an id is "<DB>-<ENTRYID>", and it "must strictly use ASCII characters matching the regular expression ^[a-zA-Z0-9:_.-]+$"; "Characters outside this set (such as spaces, slashes /, backslashes \\, parentheses, or exclamation marks) are not allowed." The JSON schema of the same release (validation/schema.json) checks only the prefix (MAL- among the home databases). The schema sets no length for an id.',
  ),
  service: verified(
    { rateLimit: null, freshnessMinutes: 15, freshnessShare: 0.995, responseLimitBytes: 32 * 1024 * 1024 },
    `${OSV_DOCS}/faq.md`,
    '"Is the API rate limited? No. Currently there is not a limit on the API." The response size limit is 32 MiB over HTTP/1.1 and none over HTTP/2. Data freshness objective: "Data sources no more than 15 minutes stale, 99.5% of the time". Availability objective 99.9% over 7 days; POST /v1/querybatch latency P50 500 ms, P90 4 s, P95 6 s.',
  ),
  withdrawn: verified(
    { field: 'withdrawn', inQueryResponses: false, inRecordResponses: true },
    `${OSV_DOCS}/faq.md#how-does-osvdev-handle-withdrawn-records`,
    'Records with the withdrawn field (an RFC 3339 time, ossf/osv-schema docs/schema.md) "will be excluded from: the responses to POST API queries"; they stay in the database, are "returned by the /vulns/<ID> GET API" and shown at https://osv.dev/vulnerability/<ID> marked as withdrawn.',
  ),
  malicious: verified(
    { idPrefix: 'MAL-', database: 'OpenSSF Malicious Packages', license: 'Apache-2.0' },
    `${OSV_SCHEMA}`,
    'The prefix table of the OSV schema lists MAL for the "Malicious Packages Repository" (github.com/ossf/malicious-packages/tree/main/osv/); OSV.dev imports it under Apache 2.0 (google/osv.dev docs/data.md). Its README (github.com/ossf/malicious-packages/blob/main/README.md) says false positives "may be present in our dataset from time-to-time": a report that is wholly a false positive is moved to osv/withdrawn/ with a withdrawn time, and for false-positive versions of a report those versions move into a database_specific array; reports are not removed. Its CONTRIBUTING.md says ids are assigned automatically and the summary is replaced by a standard one ("Malicious code in <name> (<ecosystem>)" in the records).',
  ),
  ecosystems: verified(
    { npm: 'npm', pypi: 'PyPI', packagist: 'Packagist' },
    `${OSV_SCHEMA}#affectedpackage-field`,
    'Keys are the ecosystems of depcurfew (npm, pypi and packagist; in package names of the policy no prefix, pypi: and composer:), values the ecosystem names of the OSV schema: "npm" (an NPM package name), "PyPI" (a normalized PyPI package name), "Packagist" (a PHP package name; without a :<REMOTE-REPO-URL> suffix it means https://packagist.org). OSV.dev covers all three (google/osv.dev docs/data.md, Covered Ecosystems). How it compares Packagist versions: versionMatching.',
  ),
  versionMatching: verified(
    { packagist: { ignoredPrefixes: ['v', 'V'] } },
    `${OSV_GO}/internal/database/datastore/vulnerability_matching.go`,
    'The API (go/cmd/api, with the Datastore store of go/internal/database/datastore) answers a query with a version by buildVersionMatcher: for an ecosystem it knows, it parses the version with the ecosystem helper and keeps the AffectedVersions whose coarse range holds Coarse(version), then matches each listed version of a record by parsing it too and comparing the two (versionIsMatchEcosystemVersionsList, cmp == 0), and the events of its ranges the same way. The Packagist helper (go/osv/ecosystem/packagist.go) parses with semantic.ParsePackagistVersion of google/osv-scalibr v0.5.3 (go/go.mod), whose canonicalizePackagistVersion removes one leading v or V before it compares as PHP\'s version_compare does (semantic/version-packagist.go at v0.5.3), and its Coarse removes them too, so v8.1.9 and 8.1.9 are the same version both in a query and in a record (also the coarse range the importer stores, go/internal/database/datastore/affected_versions.go). The Python helper of the workers (osv/ecosystems/packagist.py, PackagistVersion.php_canonicalize_version) removes a leading v as well. All at google/osv.dev b7449847246af793439d06284d340af40cdae854 (master on 2026-11-02). A version of composer.lock is therefore sent as Composer wrote it.',
  ),
  dataExport: verifiedLater(
    {
      url: 'https://storage.googleapis.com/osv-vulnerabilities',
      archivePath: '/{folder}/all.zip',
      folders: { npm: 'npm', pypi: 'PyPI', packagist: 'Packagist' },
      recordEntry: '{id}.json',
      withdrawnIncluded: true,
    },
    `${OSV_DOCS}/data.md`,
    'The sources "are aggregated and continuously exported to a GCS bucket maintained by OSV: gs://osv-vulnerabilities"; "Individual vulnerability records can be found at gs://osv-vulnerabilities/<ECOSYSTEM>/<ID>.json" and "A zip containing all vulnerabilities for each ecosystem is available at gs://osv-vulnerabilities/<ECOSYSTEM>/all.zip", with the example "download over HTTP via https://storage.googleapis.com/osv-vulnerabilities/PyPI/all.zip"; the zip of all ecosystems holds withdrawn records too. The folder of an ecosystem is its name: gs://osv-vulnerabilities/ecosystems.txt lists npm, PyPI and Packagist, and ecosystems with a :suffix are exported only under the main ecosystem. Read on 2026-11-03 from the bucket itself: npm/all.zip 219,811,588 bytes with 231,076 entries (223,001 MAL- records, 334 of them withdrawn; more than 65,535 entries, so the end of its central directory is in the ZIP64 format), PyPI/all.zip 37,606,501 bytes with 26,779 entries (11,976 MAL-, 25 withdrawn), Packagist/all.zip 11,087,467 bytes with 7,397 entries (1 MAL-); every entry is a file <ID>.json at the top of the zip, deflated, without encryption, data descriptor or extra field; the largest MAL- entry is 1,148,610 bytes. The bucket answers with Last-Modified, the time the zip was written. Every MAL- record of the exports written at 08:33 UTC the same day (npm 219,814,610 bytes with 223,004 MAL- entries, PyPI 11,976, Packagist 1), read in full: at most 1 affected[] entry per record; for one package in one record at most 232 versions (PyPI 86), 2 ranges and 4 events in a range; at most 2 records of one package (PyPI 1); the longest version 74 characters; the data depcurfew writes from them is 17,911,745 bytes for npm with a longest package line of 3,320 bytes (PyPI 794,277 and 789 bytes).',
  ),
  affected: verifiedLater(
    {
      affectedField: 'affected',
      packageField: 'package',
      nameField: 'name',
      ecosystemField: 'ecosystem',
      versionsField: 'versions',
      rangesField: 'ranges',
      typeField: 'type',
      eventsField: 'events',
      versionRangeTypes: ['SEMVER', 'ECOSYSTEM'],
      events: { introduced: 'introduced', fixed: 'fixed', lastAffected: 'last_affected', limit: 'limit' },
      earliest: '0',
      unlimited: '*',
    },
    'https://github.com/ossf/osv-schema/blob/v1.9.2/docs/schema.md#evaluation',
    'OSV schema 1.9.2: "A version is considered affected if it lies within any one of the ranges or is listed in the versions list"; versions holds "a single affected version in whatever version syntax is used by the given package ecosystem". A range has a type: SEMVER (SemVer 2.0.0 versions without a leading v), ECOSYSTEM ("arbitrary, uninterpreted strings specific to the package ecosystem", ordered by the ecosystem) or GIT (full commit hashes, which need the commit graph). Its events each hold one of introduced, fixed, last_affected and limit; introduced "0" is a version that sorts before any other, limit "*" is infinity, and without a limit event an implicit {"limit": "*"} is assumed. The Evaluation section: IncludedInVersions is v == version; IncludedInRanges, for each range that BeforeLimits(v) (no limit events, or some limit with v < limit), sets vulnerable = false and for evt in sorted(range.events): introduced and v >= introduced sets it true, else fixed and v >= fixed sets it false, else last_affected and v > last_affected sets it false; the version is affected when vulnerable is true. Records are matched to a package by affected[].package (name and ecosystem; a PyPI name is the normalized one of PEP 503).',
  ),
};
