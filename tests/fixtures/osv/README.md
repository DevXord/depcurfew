# OSV.dev batch query responses

Answers of `POST https://api.osv.dev/v1/querybatch` for the tests of `--osv` (`depcurfew check`, the Claude Code hook, `depcurfew mcp` and the doctor rule `known-malicious`), which run without network access. `querybatch.json` holds the queries and the response, in the order of the queries; a result without records is `{}`, as the API leaves out an empty list.

`recorded.json` says where the response comes from. `scripts/record-registry.ts` (`npm run record:registry -- osv`) sends the queries to the API and writes the response with the date. When `recordedAt` is `null`, the response was put together from the OSV.dev records listed in `constructedFrom` (the data export of OSV.dev, `gs://osv-vulnerabilities`), in the shape the API documents, because the API could not be reached where it was written; a recording replaces it.

The records used: `MAL-2026-18458` (npm `cutekitten-test` 1.0.1) and `MAL-2026-18443` (PyPI `wallet-tracking` 1.0.0) and `MAL-2026-3637` (Packagist `intercom/intercom-php` 5.0.2) of the OpenSSF malicious-packages database, and `GHSA-xxjr-mmjv-4gpg`, a vulnerability of npm `lodash` before 4.17.23 and not a malware record, so `--osv` does not report it.
