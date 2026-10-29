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
- **Badanie:** w pięciu równoległych wątkach (npm; pnpm; Yarn; Bun z Deno; Renovate z Dependabotem) zebrałem dla każdego pola wartość, URL i dosłowny cytat. Źródła zewnętrzne (blogi, trackery) służyły tylko do znalezienia tropów i nie są cytowane.
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
- **Badanie:** fakty zebrałem z URL-em i dosłownym cytatem w dwóch wątkach: pierwszy obejmował pliki blokad, workspace'y i pliki konfiguracyjne, drugi Corepacka, `devEngines`, Voltę, asdf i akcje CI.
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

## D-028 · `depgate apply`: przebieg i wyjście (2026-10-28)
- **Polecenie:** `depgate apply [katalog] [--dry-run]`.
  - Najpierw cały plan powstaje w pamięci (`planApply`, bufor `Workspace`), dopiero potem pliki są zapisywane.
  - `--dry-run` niczego nie zapisuje i wypisuje zunifikowany diff (Myers, 3 linie kontekstu) ze znacznikiem `\ No newline at end of file`, więc diff przyjmuje `git apply`.
  - Na stdout trafia wynik: lista utworzonych i zmienionych plików albo diff. Na stderr trafiają ostrzeżenia (`warning:`), fragmenty do wklejenia ręcznie i błędy (`error:`), więc wyjście `--dry-run` można zapisać jako łatkę.
- **Kody wyjścia:**
  - 0 także przy ostrzeżeniach (zatwierdzona decyzja 8);
  - 1 przy braku albo niepoprawnym `depgate.json` i przy pliku, którego nie da się edytować.
- **Wszystko albo nic:** jeśli choć jednego pliku nie da się edytować (np. zepsuty JSON albo symlink), `apply` nie zapisuje żadnego pliku. Generator, który trafił na błąd, przerywa pracę, ale pozostałe dalej działają, żeby jeden przebieg zgłosił wszystkie zepsute pliki.
- **Cele:**
  - `targets: "auto"` oznacza wykryte obsługiwane menedżery i boty;
  - Yarn Classic dostaje ostrzeżenie i nic nie jest dla niego zapisywane (zatwierdzona decyzja 4);
  - wersja menedżera to pierwsza dokładna wersja w kolejności wykrywania (`packageManager`, `devEngines`, Volta, …);
  - bez dokładnej wersji generator przyjmuje najnowszą wersję z bazy i zgłasza ostrzeżenie (zatwierdzona decyzja 5).
- **Wersje:** ustawienie nowsze niż wersja menedżera nie jest zapisywane. Ostrzeżenie ma postać `<narzędzie> <wersja> does not support <ustawienie> (since <wersja>); not written`.
- **Kolejność:**
  - najpierw menedżery paczek, potem boty;
  - w generatorze: opóźnienie → wyjątki (tylko gdy opóźnienie zostało zapisane) → skrypty instalacyjne → źródła;
  - powtórzone ostrzeżenia są usuwane.
- **Boty czekają co najmniej tyle co menedżery:** opóźnienie botów to `botDuration` = max(opóźnienie z polityki, opóźnienia zapisane przez menedżery). Przykład: przy `36h` npm zaokrągla do 2 dni, więc Renovate dostaje `"2 days"`, a Dependabot `default-days: 2`. Inaczej bot proponowałby wersje, których menedżer (np. pnpm 11 z Dependabotem) jeszcze nie zainstaluje. `explain` pokazuje przeliczenie dla każdego narzędzia osobno i nie stosuje `botDuration`.
- **Publiczne API:** `src/index.ts` eksportuje `applyProject`, `planApply`, `loadPolicy`, `PolicyError`, `botDuration`, `unifiedDiff` i typy `ApplyReport`, `FileChange`, `Snippet`.

## D-029 · Edytory plików konfiguracyjnych (2026-10-28)
- **Styl pliku:** edycja pracuje na tekście z LF. Przy zapisie przywracane są oryginalne końce linii, BOM i końcowy znak nowej linii. Nowe pliki mają LF i końcowy znak nowej linii.
- **INI (`.npmrc`) i TOML (`bunfig.toml`):** zarządzany blok ze znacznikami `# >>> depgate managed block: edit depgate.json and run depgate apply instead` i `# <<< depgate managed block` (zatwierdzona decyzja 6).
  - Istniejący blok jest podmieniany w miejscu, nowy trafia na koniec pliku (w TOML na koniec tabeli `[install]`, którą w razie potrzeby tworzy).
  - Zarządzany klucz ustawiony poza blokiem jest zakomentowany jako `# depgate: superseded by the managed block: <linia>` (zatwierdzona decyzja 7). W TOML dotyczy to także zapisu z kropką na najwyższym poziomie (`install.klucz`), a podtabele są pomijane.
  - Gdy polityka nie ma już nic do zapisania, depgate usuwa tylko własny blok.
- **YAML (`pnpm-workspace.yaml`, `.yarnrc.yml`, `dependabot.yml`):**
  - biblioteka `yaml` tylko znajduje węzły, a zmiana to minimalna edycja tekstu, bo `toString()` przeformatowuje cały dokument;
  - komentarze, cudzysłowy i odstępy poza zmienianą wartością zostają bajt w bajt, komentarz w tej samej linii co skalar też;
  - nad każdym zapisanym kluczem pojawia się linia `# managed by depgate` (zatwierdzona decyzja 6);
  - wcięcie i styl list są wykrywane z pliku.
- **JSON i JSONC (`package.json`, `deno.json(c)`, `renovate.json(c)`):** własny edytor na drzewie z pozycjami. Zachowuje komentarze, przecinki na końcu, kolejność kluczy, wcięcie (tabulator albo najmniejsze wcięcie spacjami) i jednolinijkowe kontenery. Bez znaczników, bo JSON nie ma komentarzy (zatwierdzona decyzja 6).
- **Bezpieczeństwo zapisu:**
  - depgate nie zapisuje przez symlinki ani poza repozytorium;
  - zapis idzie przez plik tymczasowy (`wx`) i `rename`;
  - istniejący plik zachowuje uprawnienia.

## D-030 · Co `apply` zarządza i jak łączy się z istniejącymi ustawieniami (2026-10-28)
- **Allowlisty skryptów są tylko uzupełniane:** npm `allowScripts`, pnpm `allowBuilds` (od 10.26.0) albo `onlyBuiltDependencies` (wcześniej; w `pnpm-workspace.yaml` od 10.5.0, a przed nią w `package.json`), Yarn `dependenciesMeta.<paczka>.built`, Bun `trustedDependencies` i Deno `allowScripts`. Wpisy spoza polityki zostają, bo `apply` nie usuwa niezarządzanych ustawień. Wzorce z `*` są pomijane z ostrzeżeniem, bo te listy przyjmują tylko nazwy.
- **Listy wyjątków od opóźnienia są zastępowane polityką:** npm `min-release-age-exclude`, pnpm `minimumReleaseAgeExclude`, Yarn `npmPreapprovedPackages`, Bun `minimumReleaseAgeExcludes`, Deno `minimumDependencyAge.exclude`, Dependabot `cooldown.exclude` i reguła Renovate. Wyjątki osłabiają ochronę, więc ich jedynym źródłem jest polityka. Wzorzec, którego narzędzie lub jego wersja nie obsługuje, jest pomijany z ostrzeżeniem, co oznacza dłuższe opóźnienie.
- **Przełączniki „pozwól na wszystko” przy `deny`:**
  - npm: `dangerously-allow-all-scripts` poza blokiem jest zakomentowane;
  - pnpm: `dangerouslyAllowAllBuilds: true` zmienia się na `false`;
  - Deno: `allowScripts: true` zastępuje lista z polityki, przy pustej liście `[]` (schemat dopuszcza pustą tablicę, a znaczenie `false` jest w bazie niepewne);
  - pnpm i Deno zgłaszają przy tym ostrzeżenie.
- **pnpm `blockExoticSubdeps`:** jedno ustawienie obejmuje git i tarballe i działa tylko dla zależności przechodnich. Dostaje `true`, gdy polityka blokuje którekolwiek z tych źródeł. Ostrzeżenie mówi, że bezpośrednie zależności pozostają dozwolone, a drugie ostrzeżenie pojawia się, gdy polityka traktuje git i tarballe różnie.
- **Yarn:** gdy polityka zarządza skryptami lub źródłem git, `enableScripts` i `approvedGitRepositories` są zapisywane jawnie, także gdy zgadzają się z wartością domyślną, żeby migracja przy aktualizacji Yarna nie wpisała łagodniejszych wartości.
- **Bun:** utworzenie `trustedDependencies` daje ostrzeżenie, bo lista zastępuje wbudowaną listę zaufanych paczek. Bun nie ma ustawienia „pozwól na wszystkie skrypty”, więc `default: "allow"` daje ostrzeżenie.
- **Renovate:**
  - edytowany jest pierwszy istniejący plik konfiguracyjny `.json`/`.jsonc`;
  - depgate zarządza `minimumReleaseAge`, regułą w `packageRules` rozpoznawaną po `description: "depgate: packages excluded from minimumReleaseAge"` (usuwaną, gdy polityka nie ma wyjątków) i `vulnerabilityAlerts.minimumReleaseAge` (`null` przy `bypass`, wartość przy `delay`);
  - `renovate.json5` i klucz `renovate` w `package.json` nie są edytowane; depgate wypisuje fragment do wklejenia (zatwierdzona decyzja 9);
  - brak pliku daje ostrzeżenie zamiast tworzenia konfiguracji (zatwierdzona decyzja 10).
- **Dependabot:**
  - depgate edytuje każdy wpis `updates` z ekosystemem npm, bun lub deno;
  - ustawia `cooldown.default-days` i `cooldown.exclude`, a pozostałe klucze `cooldown` (`semver-*-days`, `include`) zostawia;
  - Dependabot nie opóźnia aktualizacji bezpieczeństwa, więc `securityUpdates: "delay"` daje ostrzeżenie;
  - pliku nie tworzy (zatwierdzona decyzja 10).
- **Pliki menedżerów** (`.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml`, `deno.json`) są tworzone, gdy ich brakuje (zatwierdzona decyzja 10).

## D-031 · Fakty dodane w fazie 4 (2026-10-28)
- Wszystkie w `extra` danego narzędzia, ze źródłem i datą 2026-10-28. Sprawdzone w plikach źródłowych oficjalnej dokumentacji i kodu (sieć jak w D-024):
  - npm (`docs/.../npmrc.md` i `definitions.js` v12.2.1): składnia list `klucz[]=wartość`, `dangerously-allow-all-scripts` od 11.16.0, globy w `min-release-age-exclude` od 11.17.0;
  - pnpm (ustawienia 10.x, `settings/build.md` 11.x): `dangerouslyAllowAllBuilds` od 10.9.0, globy w `minimumReleaseAgeExclude` od 10.17.0, `onlyBuiltDependencies` od 10.0.0 (w `pnpm-workspace.yaml` od 10.5.0, usunięte w 11.0.0);
  - Yarn (strona o `.yarnrc.yml`): `enableScripts` jako przełącznik, globy w `npmPreapprovedPackages` od 4.10.0;
  - Bun (wpis o wydaniu 1.4.4): `minimumReleaseAgeExcludes` bez globów;
  - Deno (`config-file.v1.json` v2.9.8): klucz `age` w formie obiektowej, prefiks `npm:`, `allowScripts: true` od 2.6.0, końcowa `*` w wyjątkach od 2.9.2;
  - Renovate: reguła wyłączenia przez `packageRules` + `matchPackageNames` + `minimumReleaseAge: null`, `vulnerabilityAlerts.minimumReleaseAge`, globy w `matchPackageNames` od 38.0.0, pole `description`;
  - Dependabot: ekosystemy npm, bun i deno, klucze `default-days` i `exclude`, `*` w `exclude`.
- `docs/knowledge.md` jest wygenerowany na nowo.

## D-032 · Fikstury „przed i po” dla `apply` (2026-10-28)
- **Układ (zatwierdzona decyzja 3):**
  - `tests/fixtures/expected/<nazwa>/after/` zawiera tylko pliki, które `apply` zmienia;
  - `apply.json` zawiera `{ changed, warnings, snippets }`;
  - wspólna polityka leży w `tests/fixtures/apply/policy.json`, a fikstura może mieć własny `expected/<nazwa>/depgate.json`.
- **Test każdej fikstury sprawdza, że:**
  - wynik i raport są zgodne z oczekiwanymi;
  - pozostałe pliki się nie zmieniły;
  - żadne niezarządzane ustawienie nie zniknęło ani nie zmieniło wartości (YAML/JSON porównane po sparsowaniu, INI/TOML linia po linii);
  - drugie `apply` nie zmienia żadnego pliku.
- **Nowe fikstury:**
  - `npm-existing-config`: CRLF, tabulatory, stary blok, zarządzany klucz poza blokiem;
  - `pnpm-renovate-dependabot`: komentarze w YAML, JSONC z przecinkiem na końcu, istniejący `semver-major-days`, wpis github-actions;
  - `pnpm-allow-all-builds` i `deno-allow-all-scripts`: przełączniki „pozwól na wszystko” przy `deny`.

## D-033 · Zatwierdzenie decyzji fazy 4 (2026-10-29)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 4 poza planem:
  - „wszystko albo nic”: przy pliku, którego nie da się edytować, `apply` nic nie zapisuje i kończy się kodem 1 (D-028);
  - podział wyjścia: diff lub lista plików na stdout, ostrzeżenia, fragmenty i błędy na stderr (D-028);
  - listy wyjątków od opóźnienia zastępowane polityką, allowlisty skryptów tylko uzupełniane (D-030);
  - wyłączanie przełączników „pozwól na wszystkie skrypty” przy `deny`: pnpm `dangerouslyAllowAllBuilds` i Deno `allowScripts: true` (D-030);
  - opóźnienie botów nie krótsze niż najdłuższe zapisane przez menedżera, bez zmiany w `explain` (D-028);
  - pnpm `blockExoticSubdeps: true`, gdy polityka blokuje git albo zdalne tarballe (D-030);
  - zachowywanie komentarzy w linii zmienianej wartości, nawet gdy przestają być aktualne (D-029);
  - eksport API `apply` w `src/index.ts` (D-028);
  - wyjątek w `.gitattributes` dla fikstury z CRLF (D-032).

## D-034 · `depgate doctor`: model i wyjście (2026-10-29)
- **Polecenie:** `depgate doctor [katalog] [--json | --sarif]` (zatwierdzone decyzje 1–4 fazy 5).
  - Niczego nie zapisuje i niczego nie uruchamia. Czyta repozytorium tym samym `Repository` co wykrywanie, więc nie wychodzi poza katalog.
  - Każda reguła ma stały identyfikator kebab-case, opis, poziom (`error`, `warning`, `note`) i podpowiedź naprawy. Zgłoszenie ma plik i linię, a często też własną podpowiedź.
  - Kod wyjścia 1 tylko przy zgłoszeniu `error`. Ostrzeżenia i uwagi dają 0, niepoprawny `depgate.json` 1, a `--json` razem z `--sarif` 2.
  - Bez `depgate.json` działają tylko reguły niezależne od polityki.
- **Zgłoszenia a uwagi:** problem w repozytorium to zgłoszenie. Coś, czego doctor nie umiał sprawdzić (brak polityki, nieczytelny plik, format pliku blokady bez danych o skryptach), to uwaga (`notices`). W SARIF uwagi trafiają do `invocations[0].toolExecutionNotifications`, a nie do wyników.
- **Wyjście:**
  - tekst: zgłoszenia pogrupowane po plikach, potem uwagi;
  - JSON: `{ schemaVersion: 1, policy, findings, notices, summary }`;
  - SARIF 2.1.0: `$schema` OASIS (z erratą 01) i wszystkie reguły w `tool.driver.rules`. Region obejmuje całą linię (`startColumn`, `endLine`, `endColumn`), bo dokumentacja GitHub code scanning oznacza te pola jako wymagane. `partialFingerprints` zostawiamy akcji `upload-sarif`, która je uzupełnia.
- **Publiczne API:** `runDoctor`, `RULES`, `toSarif`, `renderText`, `countLevels` i typy raportu.

## D-035 · Reguły `doctor` (2026-10-29)
- **`manager-version-too-old`** (error, warning dla zakresu):
  - każda wersja zadeklarowana w `packageManager`, `devEngines`, Volcie, `.tool-versions` i CI musi znać każde używane ustawienie, czyli to, którego wymaga `depgate.json`, i to, które już jest w pliku menedżera;
  - przy zakresie liczy się najniższa dopuszczalna wersja (`^`, `~`, `>=`, `x`, `||`, zakres z łącznikiem);
  - wyrażeń `${{ … }}` nie da się ocenić, więc dają uwagę (zatwierdzona decyzja 9).
- **`setting-ignored-by-version`** (zatwierdzona decyzja 10): ustawienie lub plik, którego używana wersja nie czyta:
  - `npm-shrinkwrap.json` w npm 12;
  - pole `pnpm` w `package.json` i ustawienia bezpieczeństwa w `.npmrc` w pnpm 11+;
  - `onlyBuiltDependencies` po usunięciu w pnpm 11;
  - tekstowa wartość `npmMinimalAgeGate` w Yarn 4.10.
- **`npmrc-overrides-policy`:**
  - `.npmrc` w pakiecie workspace'u, którego npm nie czyta (ostrzeżenie);
  - w pnpm 10 wartość z głównego `.npmrc`, która działa, bo `pnpm-workspace.yaml` jej nie ustawia, a osłabia politykę (krótsze opóźnienie, wyjątek spoza polityki).
- **`pnpm-shared-workspace-lockfile`** (warning): pnpm 10 z `sharedWorkspaceLockfile: false` i `.npmrc` pakietu z ustawieniem bezpieczeństwa, które nadpisuje ustawienie workspace'u dla tego pakietu. Szczegóły w D-036.
- **`config-drift`:**
  - `apply` zaplanowane w pamięci: każdy plik, który `apply` by zmieniło, daje błąd przy pierwszej różnicy;
  - brakujący plik daje błąd wskazujący `depgate.json`;
  - wpis w allowliście narzędzia spoza `installScripts.allow` daje ostrzeżenie, bo `apply` celowo nie usuwa cudzych wpisów, a taki wpis pozwala na skrypty wbrew polityce.
- **`bot-cooldown-mismatch`:**
  - bot czeka krócej niż menedżer (error). Liczą się wartości efektywne: ustawienie w pliku, jeśli wersja je czyta, a w przeciwnym razie wartość domyślna dla tej wersji. Przy sporze źródeł bierzemy najdłuższą. Uwzględniamy `default-days` i `semver-*-days` Dependabota, domyślne 3 dni Dependabota oraz preset `config:best-practices` Renovate;
  - aktualizacje bezpieczeństwa omijają opóźnienie bota, a menedżer ponownie sprawdza plik blokady, czyli pnpm 11.1.3+ (warning).
- **`broad-exclusion`:** `@*/*` w `depgate.json` oraz `*`, `**`, `npm:*` i regex „wszystko” w listach wyjątków npm, pnpm, Yarn, Deno i Dependabota. Do tego reguła Renovate wyłączająca `minimumReleaseAge` dla wszystkich paczek, także bez żadnego `match*`.
- **`lockfile-forbidden-source`:** paczka z gita, z tarballa z URL, z lokalnego tarballa lub z katalogu, gdy polityka tego zabrania. Działa dla `package-lock.json` (v2+), `pnpm-lock.yaml` (9.0), `yarn.lock` (Berry) i `bun.lock`. Pakiety workspace'u nie są zgłaszane. Binarny `bun.lockb`, starsze wersje formatów i pliki, których nie da się sparsować, dają uwagę.
- **`lockfile-install-scripts`:**
  - paczka ze skryptami instalacyjnymi spoza `installScripts.allow`;
  - błąd, gdy używana wersja menedżera uruchamia skrypty domyślnie (przy sporze źródeł wystarczy jeden wariant), a ostrzeżenie, gdy je blokuje;
  - dane są tylko w npm, Bun 1.4.4+ i Deno (plik blokady v5). Dla pnpm, Yarn i Deno v4 jest uwaga (zatwierdzona decyzja 6).

## D-036 · Odstępstwa od planu fazy 5 (2026-10-29)
- **`shared-workspace-lockfile=false` w pnpm 10:**
  - plan zakładał, że to ustawienie „unieważnia opóźnienie”, ale żadne oficjalne źródło tego nie mówi (changelogi pnpm 10 i 11, dokumentacja);
  - z kodu pnpm 10 (`recursive.ts`) wynika natomiast, że bez wspólnego pliku blokady każdy projekt jest instalowany z własnym `.npmrc` nałożonym na ustawienia workspace'u;
  - reguła zgłasza więc konkretny przypadek: `.npmrc` pakietu z ustawieniem bezpieczeństwa. Fakt jest niepewny (tylko z kodu), dlatego poziom to `warning`.
- **`config-drift` ostrzega o wpisach w allowlistach spoza polityki.** Planu to nie obejmowało, ale bez tego ręcznie dopisany `"sharp": true` pozwalałby na skrypty po cichu.
- **`setting-ignored-by-version`** to reguła spoza listy w planie (zatwierdzona decyzja 10). `corepack-unavailable` przesunęliśmy na później.

## D-037 · Fakty fazy 5 (2026-10-29)
- **Sposób ustalenia:** fakty zebrałem w dwóch wątkach (pliki blokad; `.npmrc`, Renovate i SARIF) z dosłownymi cytatami. Kluczowe cytaty sprawdziłem ponownie w źródłach: kolejność czytania konfiguracji w pnpm 10, nakładanie lokalnego `.npmrc` w `recursive.ts`, `npmrc.md`, pola `hasInstallScript` i `resolved` npm, typy pliku blokady pnpm 10, `hasInstallScript` w `bun.lock` 1.4.4, pole `scripts` w `deno.lock`, sumę kontrolną schematu SARIF.
- **Nowe fakty (data 2026-10-29):**
  - `lockfileFormat` dla npm, pnpm, Yarn, Bun i Deno: jak plik blokady zapisuje źródło paczki i skrypty instalacyjne;
  - npm `npmrcScope`: tylko `.npmrc` w katalogu głównym projektu;
  - pnpm `npmrcPrecedence`: `pnpm-workspace.yaml` wygrywa z `.npmrc`;
  - pnpm `sharedWorkspaceLockfile` (domyślnie `true`) i niepewny `perProjectNpmrc`.
- **Ustrukturyzowane formy faktów z fazy 1** (te same źródła): `durationStrings` dla Yarn, Bun, Deno i Renovate, `minimumReleaseAgePresets` Renovate, `lockfileRecheck` pnpm (niepewny, jak oryginał) i `ignoredSince` pnpm 11.
- **Wymagania GitHub code scanning wobec SARIF** dotyczą formatu wyjścia, a nie menedżera paczek, więc nie trafiły do bazy. Źródło jest w kodzie (`src/doctor/sarif.ts`) i w D-034.

## D-038 · Walidacja SARIF i fikstury `doctor` (2026-10-29)
- **Schemat:** oficjalny schemat SARIF 2.1.0 (OASIS, errata 01) leży niezmieniony w `tests/fixtures/sarif/`, z adresem źródła i sumą SHA-256, którą sprawdza test (zatwierdzona decyzja 7).
- **Walidator:** własny, w `tests/support/json-schema.ts`, bez nowych zależności. Słowo kluczowe, którego nie obsługuje, kończy się błędem, więc schemat nie może przejść walidacji zrozumiany tylko częściowo. Raport SARIF każdej fikstury przechodzi walidację.
- **Fikstury (zatwierdzona decyzja 8):**
  - `tests/fixtures/doctor/<reguła>/fires-*/repo` z oczekiwanymi zgłoszeniami tej reguły w `expected.json` oraz `passes-*/repo`, w których reguła nic nie zgłasza;
  - test pilnuje, że każda reguła ma oba rodzaje;
  - na wszystkich 18 fiksturach repozytoriów po `apply` reguła `config-drift` nie zgłasza błędów, a żadna reguła nie rzuca wyjątkiem.

## D-039 · Zatwierdzenie decyzji fazy 5 (2026-10-29)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 5 poza planem:
  - reguła `pnpm-shared-workspace-lockfile` zgłasza `.npmrc` pakietu nadpisujący ustawienia workspace'u, na poziomie `warning`, bo teza z planu nie ma oficjalnego źródła (D-036);
  - `config-drift` ostrzega o wpisach w allowlistach narzędzi spoza polityki (D-035);
  - rozdzielenie zgłoszeń i uwag; uwagi w SARIF jako powiadomienia narzędzia, `partialFingerprints` uzupełnia `upload-sarif` (D-034);
  - poziomy zgłoszeń: `lockfile-install-scripts` zależnie od tego, czy menedżer uruchamia skrypty, ostrzeżenie o aktualizacjach bezpieczeństwa tylko dla pnpm 11.1.3+, zakres wersji jako ostrzeżenie (D-035);
  - wartości efektywne: przy sporze źródeł najdłuższa wartość domyślna, bez przypiętej wersji najnowsza z bazy (D-035);
  - nadpisanie w głównym `.npmrc` npm zgłasza tylko `config-drift` (D-035);
  - ostrzeżenia nie powodują porażki; `--strict` można dodać później (D-034).
