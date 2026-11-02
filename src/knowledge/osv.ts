// Facts about OSV.dev, which `--osv` of check, the Claude Code hook, depcurfew mcp and doctor asks about known malicious
// package versions (decision D-129). osv.dev is built from docs/ in google/osv.dev; the schema and its list of record
// prefixes and ecosystems are in ossf/osv-schema; the malicious-package records come from ossf/malicious-packages.
import { verifiedOn } from './define.ts';
import type { OsvKnowledge } from './types.ts';

const { verified } = verifiedOn('2026-11-02');

const OSV_DOCS = 'https://github.com/google/osv.dev/blob/master/docs';
const OSV_SCHEMA = 'https://github.com/ossf/osv-schema/blob/main/docs/schema.md';

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
    'Keys are the ecosystems of depcurfew (npm, pypi and packagist; in package names of the policy no prefix, pypi: and composer:), values the ecosystem names of the OSV schema: "npm" (an NPM package name), "PyPI" (a normalized PyPI package name), "Packagist" (a PHP package name; without a :<REMOTE-REPO-URL> suffix it means https://packagist.org). OSV.dev covers all three (google/osv.dev docs/data.md, Covered Ecosystems). It compares Packagist versions as PHP does, with a leading v left out (PackagistVersion in osv/ecosystems/packagist.py of google/osv.dev at b7449847246af793439d06284d340af40cdae854), so a version of composer.lock is sent as Composer wrote it.',
  ),
};
