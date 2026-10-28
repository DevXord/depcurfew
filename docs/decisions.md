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

## D-012 · Model bazy wiedzy (2026-10-28)
- **Decyzja:** każda wartość w `src/knowledge/` jest faktem (`Fact`) o jednym z trzech statusów:
  - `verified`: oficjalne źródło mówi to wprost;
  - `uncertain`: źródło jest oficjalne, ale wniosek nie jest rozstrzygający (np. wywnioskowany z kodu lub komentarza w issue albo z braku opcji na liście ustawień); wymaga notatki;
  - `disputed`: oficjalne źródła się różnią; zapisujemy każdy wariant z własnym `source` i `verifiedAt` oraz notatkę.
- **Wartości zależne od wersji:** zapisujemy je jako `Versioned` (`[{ since, value }]`, od najstarszej). `since: "0.0.0"` znaczy, że pierwszej wersji nie śledzimy. U Dependabota `since` jest datą, bo usługa nie ma wersji.
- **Ustawienia, których nie ma:** `setting` ma wartość `null` ze źródłem i notatką. Wtedy szczegóły ustawienia (`values`, `availableSince`, `default`, `file`, `format`, `patternSyntax`) są opcjonalne. Walidator wymaga ich, gdy ustawienie istnieje, także w dowolnym wariancie faktu spornego.
- **Boty** (Renovate, Dependabot) nie mają sekcji `sources`, bo nie rozwiązują źródeł zależności.
- **`extra`:** fakty spoza tabel, które będą potrzebne generatorom i `doctor` (np. pułapki migracji Yarn, tryb strict w pnpm, zachowanie przy braku daty publikacji).
- **Uzasadnienie:** jeden kształt danych dla walidatora, renderera i przyszłych generatorów. Sporność widać w danych, a nie tylko w komentarzach.

## D-013 · Oficjalne źródła i walidator (2026-10-28)
- **Decyzja:** `src/knowledge/sources.ts` zawiera listę dozwolonych lokalizacji dla każdego narzędzia: host, a dla github.com i github.blog także prefiks ścieżki (np. `github.com/npm/`, `github.blog/changelog/`).
- **Walidator odrzuca:**
  - brak źródła albo źródło puste;
  - adres niebędący URL-em lub bez `https`;
  - domenę spoza listy, także cudzego narzędzia;
  - błędną datę `verifiedAt` lub datę z przyszłości;
  - spór z jednym wariantem lub z identycznymi wariantami;
  - wpis `uncertain` lub `disputed` bez notatki;
  - wartość bez źródła;
  - brak wymaganego faktu;
  - nieznane lub zdublowane narzędzie.
- **Kod źródłowy:** kod w oficjalnym repozytorium (tag wydania lub `main`) uznajemy za źródło oficjalne. Jeśli wniosek wymaga interpretacji kodu, fakt dostaje status `uncertain`.
- **Konsekwencje:** `npm run docs:knowledge` przed zapisem uruchamia walidator i niczego nie zapisuje przy błędach. Test pilnuje, że `docs/knowledge.md` jest identyczny z wynikiem renderowania.

## D-014 · Sposób ustalenia faktów fazy 1 (2026-10-28)
- **Badanie:** pięciu agentów badawczych (npm; pnpm; Yarn; Bun z Deno; Renovate z Dependabotem) zebrało dla każdego pola wartość, URL i dosłowny cytat. Źródła zewnętrzne (blogi, trackery) służyły tylko do znalezienia tropów i nie są cytowane.
- **Weryfikacja:** wszystkie 42 fakty sporne i niepewne zweryfikowałem samodzielnie, ponownie pobierając ich źródła. Wynik:
  - spory się potwierdziły;
  - poprawiłem notatki (npm: wartości `allow-*` według changelogu, Deno: źródło kolejności pierwszeństwa);
  - dla Bun `trustedDependencies` ustaliłem górną granicę wersji (1.0.5).
- **Konsekwencje:** wszystkie fakty mają `verifiedAt` 2026-10-28. Przy następnej weryfikacji wystarczy zmienić datę w `verifiedOn(...)` danego modułu i przejrzeć jego źródła.

## D-011 · Język i końce linii (2026-10-28)
- **Język:** kod, komunikaty CLI i notatki w bazie wiedzy są po angielsku, bo to projekt open source, a tabela trafi do README. Dokumenty deweloperskie (`docs/decisions.md`, `docs/CHANGELOG-dev.md`) i `CLAUDE.md` są po polsku.
- **Końce linii:** `.gitattributes` wymusza LF, dzięki czemu wygenerowane pliki porównywane w testach mają takie same końce linii na Windows i Linux.
