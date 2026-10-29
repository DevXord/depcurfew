# SARIF 2.1.0 schema

`sarif-schema-2.1.0.json` is the official OASIS schema (SARIF 2.1.0 with Errata 01), copied unchanged:

- Source: https://github.com/oasis-tcs/sarif-spec/blob/1742a253eb654bf8a4ed7c60eaef7412b2c23553/sarif-2.1/schema/sarif-schema-2.1.0.json
- Schema id: https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json
- SHA-256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`
- Retrieved: 2026-10-29

`tests/doctor/sarif.test.ts` checks the hash, so the file cannot change unnoticed, and validates doctor's SARIF
output against it with the test-only validator in `tests/support/json-schema.ts`.
