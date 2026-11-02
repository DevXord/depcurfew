# Recorded Packagist responses

The v2 metadata of Packagist.org (`https://repo.packagist.org/p2/<vendor>/<name>.json`) for the tests of `depcurfew check` with `composer:` packages, which run without network access. `scripts/record-registry.ts` (`npm run record:registry -- packagist`) recorded them on the date in `recorded.json`, with read-only GET requests to repo.packagist.org whose `User-Agent` is `depcurfew-record`. Each list of versions was expanded as `MetadataMinifier::expand` does, cut down to the newest versions by `published-time` and the versions the script names, with only `version`, `version_normalized`, `time`, `published-time`, `type` and `abandoned`, and minified again (`"minified": "composer/2.0"`), so the files keep Packagist's format. The file of `vendor/name` is `vendor__name.json`; a package Packagist did not know is stored as `{"status": 404}`.

The tests pass a fixed clock, so the ages of the recorded versions do not change as time goes by.
