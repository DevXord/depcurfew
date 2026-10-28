# Decyzje projektowe

Każda decyzja ma numer, datę, uzasadnienie i konsekwencje. Nowe zależności (poza `yaml`) wymagają wpisu tutaj i zgody właściciela repozytorium.

## D-001 · TypeScript i tsdown jako narzędzie budowania (2026-10-28)
- **Decyzja:** budujemy przez tsdown, a nie tsup.
- **Uzasadnienie:** README tsup mówi, że projekt nie jest już aktywnie utrzymywany, i odsyła do tsdown (https://github.com/egoist/tsup, stan na 2026-10-28).
- **Konsekwencje:** konfiguracja jest w `tsdown.config.ts`: wejścia `src/cli.ts` i `src/index.ts`, tylko ESM, platforma node, deklaracje `.d.ts`. tsdown zachowuje shebang i nadaje `dist/cli.js` prawo wykonywania, co pilnuje test e2e.

## D-002 · Zależności deweloperskie (2026-10-28)
Właściciel zatwierdził je razem z planem faz 0–1. Żadna nie trafia do opublikowanej paczki (`files: ["dist"]`).

| Paczka | Wersja | Po co |
|---|---|---|
| `typescript` | 6.0.3 | `tsc --noEmit` oraz parser w teście ESM (`tests/meta/esm-scanner.ts`) |
| `tsdown` | 0.22.14 | build do `dist/` |
| `vitest` | 4.1.12 | testy |
| `publint` | 0.3.25 | `npm run check:pkg`: poprawność package.json i paczki |
| `@arethetypeswrong/cli` | 0.18.5 | `npm run check:pkg`: poprawność typów dla konsumentów ESM |
| `@types/node` | 22.20.5 | typy Node 22, czyli najstarszej wspieranej wersji, żeby nie użyć przypadkiem nowszego API |

## D-003 · TypeScript 6.x zamiast 7.x (2026-10-28)
- **Decyzja:** zostajemy przy `typescript@6.0.3`, choć `latest` to 7.0.2.
- **Uzasadnienie:** paczka `typescript@7.0.2` (natywny kompilator) eksportuje tylko `./lib/version.cjs` i ścieżki `./unstable/*`. Test ESM potrzebuje stabilnego `ts.createSourceFile`. tsdown akceptuje TypeScript `^5 || ^6 || ^7`.
- **Konsekwencje:** wrócimy do tematu, gdy TypeScript 7 dostanie stabilne API programistyczne.

## D-004 · Zero zależności w czasie działania w fazach 0–1 (2026-10-28)
- **Decyzja:** `dependencies` jest puste. `yaml` dojdzie w fazie 4, kiedy generatory zaczną edytować YAML.
- **Konsekwencje:** test `tests/meta/package.test.ts` dopuszcza w `dependencies` wyłącznie `yaml` i nie dopuszcza `peer`/`optional`/`bundle` dependencies.

## D-005 · Wspierane wersje Node (2026-10-28)
- **Decyzja:** `engines.node` ma wartość `>=22`. Praca nad repozytorium wymaga Node ≥ 22.18.
- **Uzasadnienie:**
  - nodejs.org (https://nodejs.org/en/about/previous-releases, 2026-10-28) podaje linie 22, 24 i 26 jako LTS, a 20 jako EOL;
  - `util.parseArgs` jest dostępny we wszystkich tych liniach;
  - Node ≥ 22.18 uruchamia pliki `.ts` natywnie (zob. D-006), a tsdown 0.22.14 wymaga `^22.18.0 || >=24.11.0`.
- **Uwaga:** lokalnie działa Node 25.8.1, czyli linia EOL. Vitest 5.x (`^22.12 || ^24 || >=26`) i tsdown 0.23.x (`^22.18 || ^24.11 || >=26`) wykluczają w `engines` Node 25. Dlatego npm wybrał starsze linie (vitest 4.1.x, tsdown 0.22.x). Po przejściu na Node 24 lub 26 warto zaktualizować te narzędzia.

## D-006 · Importy z końcówką `.ts` i natywne usuwanie typów (2026-10-28)
- **Decyzja:**
  - importy względne mają końcówkę `.ts`;
  - `tsconfig.json` włącza `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly` i `noEmit`.
- **Uzasadnienie:** Node uruchamia wtedy skrypty z `scripts/*.ts` i `src/cli.ts` bezpośrednio, bez `tsx` czy innej dodatkowej zależności. Typy sprawdza `tsc`, a bundle buduje tsdown.
- **Konsekwencje:** bez `enum`, `namespace` i parameter properties, czego pilnuje `erasableSyntaxOnly`.

## D-007 · Higiena instalacji zależności tego repozytorium (2026-10-28)
- **Decyzja:** `.npmrc` projektu ustawia `save-exact=true`, `ignore-scripts=true` i `min-release-age=7`, a `package-lock.json` jest w repozytorium.
- **Uzasadnienie:**
  - Dokumentacja npm v11 (https://docs.npmjs.com/cli/v11/using-npm/config) opisuje `min-release-age` jako liczbę dni, domyślnie `null`. Opcja uzupełnia `before`, a gdy obie są ustawione w tym samym źródle, wygrywa `before`.
  - Lokalny npm 11.11.0 rozpoznaje tę opcję: `npm config get before --min-release-age=7` zwraca datę sprzed 7 dni.
  - Według tej samej strony przy `ignore-scripts=true` polecenia `npm test` i `npm run` nadal uruchamiają skrypt, ale bez skryptów pre/post. Dlatego nie używamy hooków `pre*`/`post*`.
- **Konsekwencje:** narzędzie bezpieczeństwa samo stosuje to, czego wymaga od innych.

## D-008 · Ręczny wybór vitest 4.1.12 (poprawka bezpieczeństwa) (2026-10-28)
- **Sytuacja:**
  - `npm install vitest` przy Node 25 dał 4.1.11, którego dotyczą GHSA-qxg6-89mg-rqv8 i GHSA-xp26-3454-mjgp (`@vitest/mocker`, poziom moderate).
  - Wersja 4.1.12 zawiera poprawkę. Wydano ją 2026-10-15, ma więc 13 dni i mieści się w 7-dniowym opóźnieniu.
  - npm nie wybrał jej sam, bo tag `latest` (5.0.5) jest niezgodny z Node 25 w `engines`.
- **Decyzja:** instalujemy `vitest@4.1.12` jawnie. Po tej zmianie `npm audit` nie zgłasza podatności.
- **Lekcja dla produktu:** opóźnienie i wybór wersji według `engines` mogą razem po cichu zostawić podatną wersję. To kandydat na regułę `doctor` w fazie 5.

## D-009 · Szkielet CLI (2026-10-28)
- **Decyzja:**
  - argumenty parsuje `util.parseArgs` w trybie strict;
  - `run(argv, io)` zwraca kod wyjścia i pisze tylko przez przekazane `io`, więc da się go testować bez uruchamiania procesu;
  - `src/cli.ts` ustawia `process.exitCode` w `.then()`, bez top-level await.
- **Kody wyjścia:** 0 to sukces, 1 to błąd działania (na razie także „not implemented yet”), 2 to błąd użycia.
- **Polecenia:** `init`, `apply`, `doctor` i `explain` są widoczne w pomocy jako „planned”.

## D-010 · Testy bez sieci, wymuszone technicznie (2026-10-28)
- **Decyzja:** `tests/setup/no-network.ts` podmienia `fetch`, `net`, `tls` i `http(s)` na funkcje rzucające błąd, a potem wywołuje `syncBuiltinESMExports()`, żeby objąć też nazwane importy.
- **Konsekwencje:** test, który przypadkiem sięgnie do sieci, od razu padnie. Procesy potomne (test e2e) nie są objęte blokadą, ale niczego nie pobierają.

## D-011 · Język i końce linii (2026-10-28)
- **Język:** kod, komunikaty CLI i notatki w bazie wiedzy są po angielsku, bo to projekt open source, a tabela trafi do README. Dokumenty deweloperskie (`docs/decisions.md`, `docs/CHANGELOG-dev.md`) i `CLAUDE.md` są po polsku.
- **Końce linii:** `.gitattributes` wymusza LF, dzięki czemu wygenerowane pliki porównywane w testach mają takie same końce linii na Windows i Linux.
