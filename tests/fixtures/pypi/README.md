# Recorded index responses

Pages of the PyPI index (the JSON form of the simple repository API) for the tests of `depcurfew check`, which run without network access. `scripts/record-registry.ts` (`npm run record:registry -- pypi`) recorded them on the date in `recorded.json`. Each page keeps its `name`, `meta`, `project-status` and `versions`, and the files of the newest versions (and of the versions the script names), cut down to `filename`, `upload-time` and `yanked`. A name the index did not know is stored as `{"status": 404}`.

The tests pass a fixed clock, so the ages of the recorded files do not change as time goes by.
