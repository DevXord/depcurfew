# Recorded registry responses

Responses of the public npm registry for the tests of `depcurfew check`, which run without network access. `scripts/record-registry.ts` (`npm run record:registry`) recorded them on the date in `recorded.json`. Each package document is cut down to what `check` reads: `dist-tags`, the publish times (`time`) and, for the newest versions and the tagged ones, `scripts` and `deprecated`. A name the registry did not know is stored as `{"status": 404}`.

The tests pass a fixed clock, so the ages of the recorded versions do not change as time goes by.
