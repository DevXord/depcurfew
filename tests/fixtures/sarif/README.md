# SARIF 2.1.0 schema

`sarif-schema-2.1.0.json` is the official OASIS schema (SARIF 2.1.0 with Errata 01), copied unchanged:

- Source: https://github.com/oasis-tcs/sarif-spec/blob/1742a253eb654bf8a4ed7c60eaef7412b2c23553/sarif-2.1/schema/sarif-schema-2.1.0.json
- Schema id: https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json
- SHA-256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`
- Retrieved: 2026-10-29

`tests/doctor/sarif.test.ts` checks the hash, so the file cannot change unnoticed, and validates doctor's SARIF
output against it with the test-only validator in `tests/support/json-schema.ts`.

## Copyright and license

The schema is part of SARIF 2.1.0, a work product of the OASIS Static Analysis Results Interchange Format (SARIF)
Technical Committee. Its repository (`LICENSE.md` of oasis-tcs/sarif-spec) places the content under the OASIS
policies, including the OASIS Intellectual Property Rights Policy (https://www.oasis-open.org/policies-guidelines/ipr).
The schema file itself carries no notice; the notice below is the one of the SARIF 2.1.0 specification
(`sarif-2.1/prose/sarif-v2.1.0-committee-specification.htm` in the same repository and commit):

> Copyright © OASIS Open 2019. All Rights Reserved.
>
> All capitalized terms in the following text have the meanings assigned to them in the OASIS Intellectual Property
> Rights Policy (the "OASIS IPR Policy"). The full Policy may be found at the OASIS website.
>
> This document and translations of it may be copied and furnished to others, and derivative works that comment on or
> otherwise explain it or assist in its implementation may be prepared, copied, published, and distributed, in whole or
> in part, without restriction of any kind, provided that the above copyright notice and this section are included on
> all such copies and derivative works. However, this document itself may not be modified in any way, including by
> removing the copyright notice or references to OASIS, except as needed for the purpose of developing any document or
> deliverable produced by an OASIS Technical Committee (in which case the rules applicable to copyrights, as set forth
> in the OASIS IPR Policy, must be followed) or as required to translate it into languages other than English.
>
> The limited permissions granted above are perpetual and will not be revoked by OASIS or its successors or assigns.
>
> This document and the information contained herein is provided on an "AS IS" basis and OASIS DISCLAIMS ALL
> WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION HEREIN WILL
> NOT INFRINGE ANY OWNERSHIP RIGHTS OR ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

The file is used only by the tests and is not part of the npm package or the GitHub Action.
