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
- **Aktualizacja:** `yaml` doszła już w fazie 3, zob. D-022.

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

## D-015 · Plik polityki i jego znaczenie (2026-10-28)
- **Decyzja (zatwierdzona przez właściciela):**
  - plik `depgate.json` w katalogu repozytorium, format JSON, wymagane jest tylko `version: 1`;
  - brak sekcji oznacza, że depgate nie zarządza tym obszarem;
  - w obecnej sekcji wymagane są `cooldown.minimum` i `installScripts.default`;
  - wartości domyślne: `exclude` i `allow` to `[]`, `securityUpdates` to `"bypass"`, `targets` to `"auto"`; pominięte pole w `sources` jest niezarządzane;
  - `securityUpdates` przyjmuje `"bypass"` albo `"delay"`; `sources` ma pola `git`, `remoteTarball`, `file` i `directory` z wartościami `"allow"` albo `"deny"`.
- **Wzorce paczek:** to własna, celowo luźna gramatyka depgate, a nie kopia reguł nazw npm.
  - Dozwolona jest nazwa lub wzorzec z `*`, np. `@moja-firma/*`.
  - Odrzucane są: wersja, spacje, wzorzec złożony z samych `*` (pasowałby do każdej paczki) i powtórzenia.
  - Czy dane narzędzie obsługuje wzorzec, rozstrzygają generatory w fazie 4.
- **Błędy zamiast cichego pominięcia:**
  - nieznane pole to błąd z podpowiedzią („did you mean”), bo literówka w polityce to dokładnie konfiguracja, która po cichu nie działa;
  - z tego samego powodu błędem jest lista `installScripts.allow` przy `default: "allow"`.
- **Przykład z planu:** pełnoszerokie „＠” traktujemy jako zwykłe `@`.
- **Znane ograniczenie:** przy powtórzonym kluczu `JSON.parse` bierze ostatnią wartość bez ostrzeżenia. Wykrycie tego wymaga własnego parsera JSON.

## D-016 · Jedno źródło prawdy dla polityki (2026-10-28)
- **Decyzja:** z definicji w `src/policy/schema.ts`, zapisanej małym językiem schematu z `src/policy/shape.ts`, powstają:
  - walidator;
  - typy: `Policy` (plik, jak go zapisano) i `ResolvedPolicy` (po uzupełnieniu wartości domyślnych i sparsowaniu czasów);
  - JSON Schema.
- **`schema.json`:**
  - leży w katalogu głównym, generuje go `npm run schema`, trafia do `files` w paczce;
  - test pilnuje, że jest aktualny;
  - ma wersję draft-07, bo edytory obsługują ją najpełniej;
  - każdy obiekt ma `additionalProperties: false`, a każde pole opis do podpowiedzi w edytorze.
- **Zgodność schematu z walidatorem:**
  - sprawdza ją w testach mały interpreter podzbioru JSON Schema (`tests/policy/json-schema-subset.ts`), bez nowej zależności; na nieznanym słowie kluczowym rzuca błąd;
  - walidator jest surowszy w trzech miejscach: limit wielkości czasu, maksimum narzędzia przy jawnych `targets` oraz lista `allow` bez efektu.
- **`$schema`:** wartość `https://unpkg.com/depgate/schema.json`, zgodnie z planem. Adres zadziała po publikacji i nie jest przypięty do wersji.
- **Komunikaty:**
  - format to `ścieżka: komunikat`, ścieżka w notacji `cooldown.exclude[2]`, a `(root)` oznacza cały dokument;
  - walidator zgłasza wszystkie błędy naraz, w tym błędy zależne od kilku pól, nawet gdy inna część pliku jest błędna;
  - błędy JSON mają linię i kolumnę, a BOM jest pomijany.

## D-017 · Czas trwania w polityce (2026-10-28)
- **Decyzja:**
  - składnia to dodatnia liczba całkowita i jedna jednostka: `m`, `h`, `d` albo `w` (`^[1-9][0-9]*[mhdw]$`);
  - wartość jest przechowywana w minutach;
  - limit: liczba sekund musi być bezpieczną liczbą całkowitą, bo Bun liczy w sekundach.
- **Odrzucamy z podpowiedzią poprawnego zapisu:**
  - zero: wyłączenie opóźnienia to usunięcie sekcji `cooldown`;
  - ułamki (`1.5d` → `36h`), spacje, wielkie litery, jednostki słowne, jednostki złożone (`1d12h` → `36h`) i wiodące zera;
  - miesiące, lata i sekundy;
  - `M` czytamy jako miesiące, tak jak Renovate, nigdy jako minuty.

## D-018 · Przeliczanie na jednostki narzędzi (2026-10-28)
- **Jednostka** pochodzi z `cooldown.unit` w bazie wiedzy. Zaokrąglamy zawsze w górę, na liczbach całkowitych, z dokładną arytmetyką.
- **Zawsze liczba, nie tekst:** dotyczy to także narzędzi, które przyjmują teksty (Yarn od 4.11.0, Bun od 1.4.4). Starsze wersje tekstów nie rozumieją, a Yarn 4.10.x pomijał je po cichu.
- **Jednostka sporna:**
  - wygrywa najmniejsza jednostka, czyli największa liczba, więc wynik wystarcza przy każdym odczytaniu;
  - spór „liczba czy tekst” oraz brak ustawienia dają błąd konwersji.
- **Renovate:** dostaje tekst w jednostkach z `extra.durationUnits` (godziny, dni). Wybieramy największą jednostkę, która daje wynik dokładny, a jeśli żadna nie daje, najmniejszą z zaokrągleniem w górę: `90m` → `"2 hours"`, `1w` → `"7 days"`.
- **Maksimum** (`extra.maximumDays`; u Dependabota 90):
  - przekroczenie to błąd, bo nie da się zaokrąglić w stronę dłuższego opóźnienia;
  - przy jawnych `targets` to błąd walidacji `cooldown.minimum`, a przy `"auto"` zgłosi go `apply` w fazie 4;
  - przy sporze o maksimum wygrywa najniższe.
- **Żadne narzędzie nie dostaje `0`**, bo wszędzie oznacza ono wyłączenie opóźnienia.

## D-019 · `depgate init` (2026-10-28)
- **Polecenie:** `depgate init [katalog] [--force]` zapisuje `depgate.json` z domyślną polityką: JSON z wcięciem 2 spacji, LF, stała kolejność kluczy.
- **Domyślna polityka (zatwierdzona przez właściciela):**
  - cooldown `3d` z `"bypass"` i pustym `exclude`;
  - skrypty `"deny"` z pustą listą `allow`;
  - `git` i `remoteTarball` `"deny"`, `file` i `directory` `"allow"`;
  - `targets: "auto"`.
- **Kody wyjścia:**
  - bez `--force` istniejący plik nie zostanie nadpisany: zapis z flagą `wx`, kod 1;
  - nadmiarowe argumenty i opcja innego polecenia dają kod 2.
- **Opcje poleceń:** są opisane w `COMMANDS` (`options`). `parseArgs` w trybie strict zna wszystkie, a `run` odrzuca opcję należącą do innego polecenia. `CliIo` i kody wyjścia przeniosłem do `src/cli/io.ts`; `run.ts` je reeksportuje.
- **Wykrywanie narzędzi** należy do późniejszej fazy. Na razie opis `init` w pomocy mówi tylko o tworzeniu pliku.

## D-020 · Fakty fazy 2 i sposób ich weryfikacji (2026-10-28)
- **Nowe fakty:**
  - Renovate `extra.durationUnits` = godziny i dni;
  - Dependabot `extra.maximumDays` = 90.
- **Weryfikacja przy zablokowanej sieci:**
  - sieć sesji nie przepuszczała docs.renovatebot.com, docs.github.com ani github.com;
  - pliki źródłowe tych stron przeczytałem przez raw.githubusercontent.com z repozytoriów `renovatebot/renovate` i `github/docs`;
  - Renovate: `docs/usage/key-concepts/minimum-release-age.md`, `docs/usage/configuration-options.md`, `lib/util/pretty-time.ts` z testami i `lib/util/minimum-release-age.ts`;
  - Dependabot: samouczek `optimizing-pr-creation-version-updates.md`, który mówi wprost: „The number of cooldown days must be between 1 and 90”.
- **Cytowanie:**
  - Renovate cytuję adresem pliku na `github.com/renovatebot/` (dozwolona lokalizacja);
  - Dependabota cytuję adresem strony docs.github.com zbudowanej z tego pliku, bo `github/docs` nie jest na liście oficjalnych lokalizacji Dependabota.
- **Kandydat na fazę 5:** `lib/util/minimum-release-age.ts` zamienia niepoprawny `minimumReleaseAge` na 0 (`coerceNumber(toMs(...), 0)`). Literówka w Renovate po cichu wyłącza więc opóźnienie. Faktu jeszcze nie dopisuję.

## D-021 · Zatwierdzenie decyzji fazy 2 i publiczne API (2026-10-28)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 2 poza planem:
  - lista `allow` bez efektu i nieznane pola to błędy (D-015);
  - Yarn i Bun zawsze dostają liczby, Renovate tylko godziny i dni (D-018);
  - czas trwania ma tylko limit techniczny, a `M` oznacza miesiące (D-017);
  - fakty fazy 2 zweryfikowano w plikach źródłowych dokumentacji (D-020);
  - powtórzone klucze JSON nie są wykrywane (D-015);
  - zamiana niepoprawnego czasu na 0 w Renovate to kandydat na regułę `doctor` w fazie 5 (D-020).
- **Publiczne API:** `src/index.ts` eksportuje funkcje polityki: `parsePolicy`, `validatePolicy`, `formatIssue`, `parseDuration`, `formatDuration`, `convertCooldown`, `convertMinutes`, `toDurationString`, `DEFAULT_POLICY`, `renderPolicy`, `POLICY_FILE` i `SCHEMA_URL`, a także typy `Policy`, `ResolvedPolicy`, `PolicyIssue`, `Duration` i `CooldownConversion`. Zmiana tych nazw po wydaniu 1.0 będzie zmianą łamiącą.

## D-022 · Zależność `yaml` od fazy 3 (2026-10-28)
- **Decyzja (zatwierdzona przez właściciela):** `yaml@2.9.1` w `dependencies`, przypięta dokładnie.
- **Uzasadnienie:** wykrywanie czyta workflow GitHub Actions i `pnpm-workspace.yaml`. Własny parser YAML byłby w narzędziu bezpieczeństwa większym ryzykiem niż jedna zależność bez zależności przechodnich.
- **Weryfikacja w rejestrze npm (2026-10-28):**
  - wersja z tagiem `latest`, opublikowana 2026-09-11, czyli 47 dni temu (powyżej 7-dniowego opóźnienia);
  - zero zależności, licencja ISC;
  - jedyny opiekun i wydawca to `eemeli`; paczka nie ma atestacji proweniencji;
  - `npm audit` nie zgłasza podatności.
- **Konsekwencje:** paczka jest w formacie CommonJS, ale nazwane importy z ESM działają w Node 22. Test `tests/meta/package.test.ts` już dopuszczał `yaml`.

## D-023 · Wiedza o projekcie i środowisku (2026-10-28)
- **Sekcja `project`** w module każdego menedżera paczek:
  - zawiera `lockfiles` (zależne od wersji), `manifests`, `workspaces` i `workspacesObjectKey`;
  - jest wymagana przez `requiredFactPaths`;
  - w `docs/knowledge.md` ma tabelę „Project files”.
- **Dział „środowisko”** (`src/knowledge/environment.ts`):
  - Corepack: klucz `packageManager` i obsługiwane menedżery, od której wersji czyta `devEngines` i `.corepack.env`, dystrybucja z Node.js;
  - `devEngines` w npm;
  - Volta: klucz w `package.json` i status utrzymania;
  - asdf: plik `.tool-versions` i nazwy wtyczek;
  - GitHub Actions: katalog workflow i rozszerzenia, a także pięć akcji instalujących narzędzia, z nazwami wejść.
- **Źródła:** dział ma własną listę oficjalnych lokalizacji (`ENVIRONMENT_SOURCES`): nodejs.org, docs.github.com oraz `github.com/` z prefiksami `nodejs/`, `npm/`, `volta-cli/`, `asdf-vm/`, `actions/`, `pnpm/`, `oven-sh/` i `denoland/`.
- **Walidacja i renderowanie:** `validateEnvironment` stosuje te same reguły co dla narzędzi. Renderer ma sekcję „Environment”, a notatki i lista „To review” obejmują też środowisko.
- **Fakty dodatkowe:**
  - Yarn: `berryLockfileMarker` (niepewny) i `classicLockfileHeader`;
  - Renovate: `packageJsonConfig`, czyli przestarzały klucz `renovate` w `package.json`.
- **Konsekwencje:** detektor bierze nazwy plików, klucze i akcje wyłącznie z bazy (`src/detect/knowledge.ts`). Przy fakcie spornym łączy nazwy plików ze wszystkich wariantów, żeby żadnego pliku nie przeoczyć.

## D-024 · Sposób ustalenia faktów fazy 3 (2026-10-28)
- **Badanie:** dwóch agentów badawczych zebrało fakty z URL-em i dosłownym cytatem. Jeden zajmował się plikami blokad, workspace'ami i plikami konfiguracyjnymi, drugi Corepackiem, `devEngines`, Voltą, asdf i akcjami CI.
- **Weryfikacja wyrywkowa:** sam sprawdziłem wejścia wszystkich akcji (`action.yml`), nazwy wtyczek asdf, format `packageManager`, strukturę klucza `volta`, shrinkwrap w npm 11 i 12, plik blokady i workspace'y Bun, formy `workspace` w Deno, znaczniki plików blokad Yarn oraz klucz `renovate` w `package.json`.
- **Sieć:**
  - z sesji były dostępne tylko raw.githubusercontent.com, yarnpkg.com, nodejs.org i rejestr npm;
  - dokumentację npm, pnpm, Bun, Deno, Volty, asdf i GitHuba czytałem z plików źródłowych w oficjalnych repozytoriach;
  - cytuję je adresem `github.com/<org>/<repo>/blob/<ref>/<ścieżka>`; wyjątkiem jest składnia workflow, cytowana adresem strony docs.github.com zbudowanej z pliku w `github/docs`.
- **Fakty niepewne:**
  - forma obiektowa `workspaces` w npm i Yarn (wynika z kodu);
  - brak formy obiektowej w pnpm (wniosek z braku opisu);
  - odczyt `bun.lockb` po Bun 1.2;
  - znacznik `__metadata` w Yarn Berry.
- **Spostrzeżenia na fazy 4–5:**
  - npm 12 nie czyta `npm-shrinkwrap.json`;
  - Node.js 25+ nie zawiera Corepacka;
  - Volta nie jest utrzymywana;
  - dla pnpm 11+ jest nowa akcja `pnpm/setup`;
  - pnpm czyta `pnpm-workspace.yaml` także w projekcie jednopakietowym i ignoruje `workspaces` z `package.json`.

## D-025 · Model wykrywania (2026-10-28)
- **Granice:** `detectProject(katalog)` tylko czyta pliki.
  - Nie korzysta z sieci i niczego z repozytorium nie uruchamia.
  - Nie wychodzi poza katalog repozytorium, także przez symlinki.
  - Pomija `node_modules` i `.git`.
  - Pliki większe niż 1 MiB pomija z ostrzeżeniem, a z `yarn.lock` czyta tylko pierwsze 4 KiB.
- **Kiedy menedżer jest w użyciu:** gdy ma dowód: plik blokady, `packageManager`, `devEngines.packageManager`, własny plik konfiguracyjny albo krok instalacji w CI. Sama wersja w Volcie lub `.tool-versions` nie wystarcza.
- **Brak dowodu przy obecnym `package.json`:** zakładamy npm i zgłaszamy ostrzeżenie `package-manager-assumed`, żeby `targets: "auto"` nie skończyło się po cichu niczym.
- **Yarn:** Berry czy Classic rozstrzyga plik blokady, a gdy go nie ma, wersja w `packageManager`. Classic jest wykrywany, ale oznaczony jako nieobsługiwany (zatwierdzona decyzja 4).
- **Pliki konfiguracyjne:** `.npmrc` jest listowane osobno (`npmrcFiles`), bo czyta je kilka narzędzi. Pliki konfiguracyjne menedżera nie obejmują `package.json` ani `.npmrc`, za to obejmują pakiety workspace'u.
- **Wersje:** zapisuję je dosłownie, także zakresy i wyrażenia `${{ … }}`, z plikiem i linią. Porównanie z wersjami minimalnymi to zadanie fazy 5.
- **Workspace'y:** własny matcher z `*`, `**` i `!`. Wzorce z `..` lub ścieżką absolutną odrzucam z ostrzeżeniem.
- **Kody ostrzeżeń:** `invalid-file`, `file-too-large`, `outside-repository`, `invalid-package-manager`, `workspace-outside-repository`, `multiple-lockfiles`, `package-manager-mismatch`, `yarn-classic-unsupported`, `renovate-config-in-package-json`, `package-manager-assumed`, `nothing-detected`.
- **Ograniczenia:**
  - nie są śledzone: `lock.path` w `deno.json`, inny `package_json_file` w akcji pnpm, workflow wielokrotnego użytku i akcje złożone;
  - `npm install -g npm@…` w krokach `run` rozpoznaje wyrażenie regularne.

## D-026 · `depgate explain` i fikstury repozytoriów (2026-10-28)
- **Polecenie:** `depgate explain [katalog] [--json]` zwraca JSON `{ schemaVersion: 1, project, policy }`.
  - Bez `depgate.json` pole `policy` ma wartość `null`.
  - Z poprawną polityką raport zawiera `targets`. Przy `"auto"` są to wykryte obsługiwane menedżery i boty, przy liście dokładnie wymienione narzędzia.
  - Raport zawiera też `cooldown: { minimum, tools }` z wartościami przeliczonymi jak w fazie 2. Narzędzie, którego maksimum na to nie pozwala, dostaje `ok: false` z powodem.
  - Niepoprawna polityka daje listę błędów i kod wyjścia 1.
- **`init`:** wypisuje wykryte narzędzia; treść tworzonego pliku się nie zmienia.
- **Opcje:** każde polecenie ma własne: `--force` należy do `init`, `--json` do `explain`.
- **Publiczne API:** `src/index.ts` eksportuje też `detectProject` i typy wyniku (`Detection`, `DetectionWarning`, `PackageManagerInfo`, `VersionDeclaration`).
- **Fikstury (zatwierdzona decyzja 3):**
  - repozytoria leżą w `tests/fixtures/repos/<nazwa>/`, oczekiwany wynik wykrywania w `tests/fixtures/expected/<nazwa>/detect.json`;
  - fikstury nie mają prawdziwych zależności;
  - polecenie w `CLAUDE.md` zmieniłem na `explain tests/fixtures/repos/<nazwa>`.

## D-027 · Zatwierdzenie decyzji fazy 3 (2026-10-28)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 3 poza planem:
  - domyślny npm z ostrzeżeniem `package-manager-assumed`, gdy jest `package.json`, ale brak dowodu użycia menedżera (D-025);
  - format JSON `explain` (`{ schemaVersion: 1, project, policy }`, `cooldown: { minimum, tools }`) i kod wyjścia 1 przy niepoprawnym `depgate.json` (D-026);
  - obsługa akcji `pnpm/setup` obok `pnpm/action-setup` (D-023);
  - eksport `detectProject` i typów wyniku w publicznym API (D-026);
  - matcher workspace'ów, w którym `*` dopasowuje też katalogi zaczynające się od kropki (D-025);
  - spostrzeżenia dla faz 4–5 (D-024).
