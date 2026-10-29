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
  - plik `depcurfew.json` w katalogu repozytorium, format JSON, wymagane jest tylko `version: 1`;
  - brak sekcji oznacza, że depcurfew nie zarządza tym obszarem;
  - w obecnej sekcji wymagane są `cooldown.minimum` i `installScripts.default`;
  - wartości domyślne: `exclude` i `allow` to `[]`, `securityUpdates` to `"bypass"`, `targets` to `"auto"`; pominięte pole w `sources` jest niezarządzane;
  - `securityUpdates` przyjmuje `"bypass"` albo `"delay"`; `sources` ma pola `git`, `remoteTarball`, `file` i `directory` z wartościami `"allow"` albo `"deny"`.
- **Wzorce paczek:** to własna, celowo luźna gramatyka depcurfew, a nie kopia reguł nazw npm.
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
- **`$schema`:** wartość `https://unpkg.com/depcurfew/schema.json`, zgodnie z planem. Adres zadziała po publikacji i nie jest przypięty do wersji.
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

## D-019 · `depcurfew init` (2026-10-28)
- **Polecenie:** `depcurfew init [katalog] [--force]` zapisuje `depcurfew.json` z domyślną polityką: JSON z wcięciem 2 spacji, LF, stała kolejność kluczy.
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

## D-026 · `depcurfew explain` i fikstury repozytoriów (2026-10-28)
- **Polecenie:** `depcurfew explain [katalog] [--json]` zwraca JSON `{ schemaVersion: 1, project, policy }`.
  - Bez `depcurfew.json` pole `policy` ma wartość `null`.
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
  - format JSON `explain` (`{ schemaVersion: 1, project, policy }`, `cooldown: { minimum, tools }`) i kod wyjścia 1 przy niepoprawnym `depcurfew.json` (D-026);
  - obsługa akcji `pnpm/setup` obok `pnpm/action-setup` (D-023);
  - eksport `detectProject` i typów wyniku w publicznym API (D-026);
  - matcher workspace'ów, w którym `*` dopasowuje też katalogi zaczynające się od kropki (D-025);
  - spostrzeżenia dla faz 4–5 (D-024).

## D-028 · `depcurfew apply`: przebieg i wyjście (2026-10-28)
- **Polecenie:** `depcurfew apply [katalog] [--dry-run]`.
  - Najpierw cały plan powstaje w pamięci (`planApply`, bufor `Workspace`), dopiero potem pliki są zapisywane.
  - `--dry-run` niczego nie zapisuje i wypisuje zunifikowany diff (Myers, 3 linie kontekstu) ze znacznikiem `\ No newline at end of file`, więc diff przyjmuje `git apply`.
  - Na stdout trafia wynik: lista utworzonych i zmienionych plików albo diff. Na stderr trafiają ostrzeżenia (`warning:`), fragmenty do wklejenia ręcznie i błędy (`error:`), więc wyjście `--dry-run` można zapisać jako łatkę.
- **Kody wyjścia:**
  - 0 także przy ostrzeżeniach (zatwierdzona decyzja 8);
  - 1 przy braku albo niepoprawnym `depcurfew.json` i przy pliku, którego nie da się edytować.
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
- **INI (`.npmrc`) i TOML (`bunfig.toml`):** zarządzany blok ze znacznikami `# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead` i `# <<< depcurfew managed block` (zatwierdzona decyzja 6).
  - Istniejący blok jest podmieniany w miejscu, nowy trafia na koniec pliku (w TOML na koniec tabeli `[install]`, którą w razie potrzeby tworzy).
  - Zarządzany klucz ustawiony poza blokiem jest zakomentowany jako `# depcurfew: superseded by the managed block: <linia>` (zatwierdzona decyzja 7). W TOML dotyczy to także zapisu z kropką na najwyższym poziomie (`install.klucz`), a podtabele są pomijane.
  - Gdy polityka nie ma już nic do zapisania, depcurfew usuwa tylko własny blok.
- **YAML (`pnpm-workspace.yaml`, `.yarnrc.yml`, `dependabot.yml`):**
  - biblioteka `yaml` tylko znajduje węzły, a zmiana to minimalna edycja tekstu, bo `toString()` przeformatowuje cały dokument;
  - komentarze, cudzysłowy i odstępy poza zmienianą wartością zostają bajt w bajt, komentarz w tej samej linii co skalar też;
  - nad każdym zapisanym kluczem pojawia się linia `# managed by depcurfew` (zatwierdzona decyzja 6);
  - wcięcie i styl list są wykrywane z pliku.
- **JSON i JSONC (`package.json`, `deno.json(c)`, `renovate.json(c)`):** własny edytor na drzewie z pozycjami. Zachowuje komentarze, przecinki na końcu, kolejność kluczy, wcięcie (tabulator albo najmniejsze wcięcie spacjami) i jednolinijkowe kontenery. Bez znaczników, bo JSON nie ma komentarzy (zatwierdzona decyzja 6).
- **Bezpieczeństwo zapisu:**
  - depcurfew nie zapisuje przez symlinki ani poza repozytorium;
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
  - depcurfew zarządza `minimumReleaseAge`, regułą w `packageRules` rozpoznawaną po `description: "depcurfew: packages excluded from minimumReleaseAge"` (usuwaną, gdy polityka nie ma wyjątków) i `vulnerabilityAlerts.minimumReleaseAge` (`null` przy `bypass`, wartość przy `delay`);
  - `renovate.json5` i klucz `renovate` w `package.json` nie są edytowane; depcurfew wypisuje fragment do wklejenia (zatwierdzona decyzja 9);
  - brak pliku daje ostrzeżenie zamiast tworzenia konfiguracji (zatwierdzona decyzja 10).
- **Dependabot:**
  - depcurfew edytuje każdy wpis `updates` z ekosystemem npm, bun lub deno;
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
  - wspólna polityka leży w `tests/fixtures/apply/policy.json`, a fikstura może mieć własny `expected/<nazwa>/depcurfew.json`.
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

## D-034 · `depcurfew doctor`: model i wyjście (2026-10-29)
- **Polecenie:** `depcurfew doctor [katalog] [--json | --sarif]` (zatwierdzone decyzje 1–4 fazy 5).
  - Niczego nie zapisuje i niczego nie uruchamia. Czyta repozytorium tym samym `Repository` co wykrywanie, więc nie wychodzi poza katalog.
  - Każda reguła ma stały identyfikator kebab-case, opis, poziom (`error`, `warning`, `note`) i podpowiedź naprawy. Zgłoszenie ma plik i linię, a często też własną podpowiedź.
  - Kod wyjścia 1 tylko przy zgłoszeniu `error`. Ostrzeżenia i uwagi dają 0, niepoprawny `depcurfew.json` 1, a `--json` razem z `--sarif` 2.
  - Bez `depcurfew.json` działają tylko reguły niezależne od polityki.
- **Zgłoszenia a uwagi:** problem w repozytorium to zgłoszenie. Coś, czego doctor nie umiał sprawdzić (brak polityki, nieczytelny plik, format pliku blokady bez danych o skryptach), to uwaga (`notices`). W SARIF uwagi trafiają do `invocations[0].toolExecutionNotifications`, a nie do wyników.
- **Wyjście:**
  - tekst: zgłoszenia pogrupowane po plikach, potem uwagi;
  - JSON: `{ schemaVersion: 1, policy, findings, notices, summary }`;
  - SARIF 2.1.0: `$schema` OASIS (z erratą 01) i wszystkie reguły w `tool.driver.rules`. Region obejmuje całą linię (`startColumn`, `endLine`, `endColumn`), bo dokumentacja GitHub code scanning oznacza te pola jako wymagane. `partialFingerprints` zostawiamy akcji `upload-sarif`, która je uzupełnia.
- **Publiczne API:** `runDoctor`, `RULES`, `toSarif`, `renderText`, `countLevels` i typy raportu.

## D-035 · Reguły `doctor` (2026-10-29)
- **`manager-version-too-old`** (error, warning dla zakresu):
  - każda wersja zadeklarowana w `packageManager`, `devEngines`, Volcie, `.tool-versions` i CI musi znać każde używane ustawienie, czyli to, którego wymaga `depcurfew.json`, i to, które już jest w pliku menedżera;
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
  - brakujący plik daje błąd wskazujący `depcurfew.json`;
  - wpis w allowliście narzędzia spoza `installScripts.allow` daje ostrzeżenie, bo `apply` celowo nie usuwa cudzych wpisów, a taki wpis pozwala na skrypty wbrew polityce.
- **`bot-cooldown-mismatch`:**
  - bot czeka krócej niż menedżer (error). Liczą się wartości efektywne: ustawienie w pliku, jeśli wersja je czyta, a w przeciwnym razie wartość domyślna dla tej wersji. Przy sporze źródeł bierzemy najdłuższą. Uwzględniamy `default-days` i `semver-*-days` Dependabota, domyślne 3 dni Dependabota oraz preset `config:best-practices` Renovate;
  - aktualizacje bezpieczeństwa omijają opóźnienie bota, a menedżer ponownie sprawdza plik blokady, czyli pnpm 11.1.3+ (warning).
- **`broad-exclusion`:** `@*/*` w `depcurfew.json` oraz `*`, `**`, `npm:*` i regex „wszystko” w listach wyjątków npm, pnpm, Yarn, Deno i Dependabota. Do tego reguła Renovate wyłączająca `minimumReleaseAge` dla wszystkich paczek, także bez żadnego `match*`.
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

## D-040 · GitHub Action (2026-10-29)
- **Typ:** akcja composite w `action.yml` w katalogu głównym repozytorium, używana jako `uses: DevXord/depcurfew@<pełny SHA>`.
- **Kroki:**
  - sprawdza wersję Node na runnerze i tylko przy wersji starszej niż 22 uruchamia `actions/setup-node` (bez cache menedżera paczek);
  - uruchamia `doctor` przez `action/depcurfew.mjs`;
  - wysyła SARIF przez `github/codeql-action/upload-sarif`;
  - kończy krok błędem.
- **Dlaczego błąd jest w osobnym kroku:** krok z `doctor` nigdy nie kończy się błędem z powodu zgłoszeń, więc wysyłka SARIF działa także wtedy, gdy są błędy. O porażce decyduje ostatni krok: błąd `doctor` przy `fail-on-error: true` albo brak możliwości uruchomienia (np. niepoprawny `depcurfew.json`).
- **Wejścia:** `directory`, `sarif-file`, `upload-sarif`, `category`, `fail-on-error`.
  - Trafiają do skryptu przez zmienne środowiskowe, a nie przez `${{ }}` w poleceniu powłoki, więc nie da się nimi wstrzyknąć polecenia.
  - Katalog spoza workspace'u jest odrzucany.
- **Wyjścia:** `errors`, `warnings`, `notes`, `sarif-file`.
- **Ścieżki w SARIF:** przy `directory` innym niż `.` ścieżki dostają ten katalog jako prefiks, bo code scanning liczy je od katalogu głównego repozytorium.

## D-041 · Zbudowany plik akcji w repozytorium (2026-10-29)
- **Plik:** `action/depcurfew.mjs` powstaje z `src/action-main.ts` przez `npm run build:action` (`tsdown.action.config.ts`). To jeden plik bez minifikacji, z dołączonym `yaml`, więc akcja nie instaluje niczego przy uruchomieniu (zatwierdzona decyzja 1).
- **Ograniczenie importów:** `deps.onlyBundle` dopuszcza tylko `yaml`, a `deps.onlyImport: []` pozwala wynikowi importować wyłącznie moduły wbudowane Node.
- **Licencja:** licencja `yaml` (ISC) leży w `action/THIRD_PARTY_LICENSES.md`.
- **Pilnowanie zgodności ze źródłem:**
  - test (`tests/action/bundle.test.ts`) buduje akcję do katalogu tymczasowego i porównuje wynik z zatwierdzonym plikiem bajt po bajcie;
  - sprawdza też importy i licencje;
  - CI dodatkowo uruchamia `npm run build:action` i `git diff --exit-code -- action/`.
  - Zatwierdzony plik nie może więc rozjechać się ze źródłem.

## D-042 · Przypięcie akcji i workflow repozytorium (2026-10-29)
- **Przypięte wersje** (pełny SHA commita i komentarz z wersją, ustalone przez `git ls-remote` 2026-10-29):
  - `actions/checkout` v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`);
  - `actions/setup-node` v7.1.0 (`949feb2413d6458794dcd2491c4babbbce0c15c1`);
  - `github/codeql-action/upload-sarif` v4.39.1 (`9b3254085494b55a0f7c4c2b3d2d52cc712ce370`, commit, nie obiekt tagu).
- **Test przypięcia** (`tests/meta/pinned-actions.test.ts`) pilnuje, że każde `uses:` w `action.yml` i w `.github/workflows/` ma pełny SHA z komentarzem `# vX.Y.Z` oraz że dana akcja ma wszędzie ten sam SHA.
- **`ci.yml`:**
  - Node 22 i 24;
  - `npm ci` (projektowy `.npmrc` wyłącza skrypty), `npm test`, `typecheck`, `check:pkg` i zgodność bundla akcji;
  - `permissions: contents: read`, `persist-credentials: false`, `package-manager-cache: false`.
- **`action-test.yml`:** test akcji, opisany w D-044.

## D-043 · README (2026-10-29)
- **Język i treść:** README po angielsku (D-011): po co, 5-minutowy start, instalacja, plik polityki, polecenia, wspierane narzędzia, reguły `doctor`, GitHub Action, biblioteka, zasady wkładu.
- **Sekcje generowane:**
  - `npm run docs:readme` (`src/docs/readme.ts`, `scripts/generate-readme.ts`) przepisuje tekst między znacznikami `<!-- BEGIN GENERATED: … -->`;
  - polityka domyślna i pola pochodzą z definicji polityki;
  - tabela narzędzi z datą weryfikacji pochodzi z bazy wiedzy;
  - reguły pochodzą z `RULES`;
  - wejścia i wyjścia pochodzą z `action.yml`;
  - przykładowy workflow bierze uprawnienia z bazy wiedzy, a pin `actions/checkout` z `ci.yml`.
- **Testy (`tests/docs/readme.test.ts`):**
  - README jest zgodny z generatorem;
  - poza sekcjami generowanymi nie pada żadna nazwa ustawienia z bazy wiedzy, z wyjątkiem nazw, które są też polami `depcurfew.json` (np. `cooldown`). README nie podaje więc własnych faktów o menedżerach paczek.
- **Instalacja:** opis docelowy (`npx depcurfew`) z adnotacją o braku publikacji i instrukcją uruchomienia ze źródeł (zatwierdzona decyzja 3).
- **Przykład Action:** `DevXord/depcurfew@<full-commit-sha>` (zatwierdzona decyzja 4).

## D-044 · Test akcji na repozytorium testowym (2026-10-29)
- **Repozytorium testowe:** samo depcurfew z fiksturami. Workflow `action-test.yml` używa `uses: ./`:
  - depcurfew na sobie, z wysyłką SARIF (kategoria `depcurfew-self`);
  - czysta fikstura, z wysyłką (`depcurfew-fixture-clean`);
  - fikstura z błędem, bez wysyłki, żeby nie tworzyć alertów z celowo złych fikstur: krok musi się nie udać, `errors` musi wynosić 1, a ścieżka w SARIF musi zaczynać się od katalogu fikstury (zatwierdzona decyzja 5);
  - runner z Node 20: akcja sama instaluje Node 22.
- **Wynik:** sprawdzony na GitHubie przy commicie `3bead20` (przebiegi 40838113951 i 40838113787). Wszystkie zadania przeszły. Upload-sarif zwalidował i przetworzył raport („Successfully uploaded results”, „Analysis upload status is complete”). Na runnerze z Node 20 akcja zainstalowała Node 22.23.4 i uruchomiła `doctor`.
- **Baza wiedzy:** nowy fakt w dziale „środowisko”, `githubActions.codeScanningUpload` (akcja, wejścia `sarif_file` i `category`, uprawnienia `security-events: write` oraz `actions: read` i `contents: read` w repozytoriach prywatnych), ze źródłem w dokumentacji GitHuba (zatwierdzona decyzja 2).

## D-045 · Zatwierdzenie decyzji fazy 6 (2026-10-29)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 6:
  - Node 22 zainstalowany przez akcję zostaje w kolejnych krokach zadania użytkownika (D-040);
  - workflow repozytorium uruchamiają się przy pushu na każdą gałąź i przy PR (D-042);
  - test akcji wysyła przy każdym pushu analizy `depcurfew-self` i `depcurfew-fixture-clean` do code scanning (D-044);
  - przykładowy workflow w README podaje `actions: read` i `contents: read` tylko dla repozytoriów prywatnych, jak przykład w dokumentacji GitHuba (D-043);
  - opisy reguł w README pochodzą z metadanych reguł, a fakty, które przywołują, są w bazie wiedzy (D-043);
  - wymaganie „Node.js 22 or later” w README jest wpisane ręcznie i trzeba je zmieniać razem z `engines`;
  - w workflow repozytorium cache menedżera paczek jest wyłączony, a `actions/checkout` nie zostawia tokenu (`persist-credentials: false`) (D-042).

## D-046 · Wydawanie przez trusted publishing i publikację etapową (2026-10-29)
- **Workflow `.github/workflows/release.yml`:**
  - uruchamia się tylko na tagach stabilnych `vX.Y.Z` (zatwierdzona decyzja 2);
  - ma uprawnienia `permissions: {}`, a zadanie dostaje tylko `contents: read` i `id-token: write`;
  - Node 24 (npm 11.19.1) i jawne sprawdzenie npm 11.15.0+ oraz Node 22.14+;
  - zgodność tagu z `package.json`, `npm ci`, wszystkie testy, `typecheck`, `check:pkg`, zgodność bundla akcji i `depcurfew doctor` na sobie;
  - na końcu `npm stage publish --provenance`;
  - nie ma tokenu npm ani sekretów, a akcje są przypięte do SHA.
- **Tylko etapowanie:** trusted publisher ma prawo tylko do `npm stage publish`, bez `npm publish`, więc każde wydanie wymaga zatwierdzenia z 2FA (zatwierdzona decyzja 1). Bez środowiska GitHub; bramką jest zatwierdzenie na npm (zatwierdzona decyzja 6).
- **Utworzenie nowej paczki:** trusted publishera da się skonfigurować tylko dla istniejącej paczki. `docs/RELEASING.md` opisuje utworzenie paczki przez etapowanie wersji próbnej, które publikuje wersję zastępczą `0.0.0-stage`, i odrzucenie tej wersji. Opisuje też konfigurację `npm trust github … --allow-stage-publish`, wyłączenie publikacji tokenami i wydanie w ciągu 2 dni od konfiguracji.
- **Test `tests/meta/release.test.ts`** pilnuje:
  - tagów tylko w postaci `vX.Y.Z`;
  - uprawnień;
  - braku sekretów i tokenów;
  - `npm stage publish --provenance` zamiast `npm publish`;
  - kolejności sprawdzeń przed etapowaniem;
  - wyłączonego cache i `persist-credentials: false`.

## D-047 · Polityka depcurfew dla samego projektu (2026-10-29)
- **`depcurfew.json`:** opóźnienie 7 dni (jak wcześniej w `.npmrc`), skrypty instalacyjne `deny` bez wyjątków, wszystkie źródła spoza rejestru `deny`.
- **Zastosowanie:** `depcurfew apply` zapisało blok w `.npmrc`. Dawny wiersz `min-release-age=7` zastąpił komentarz wskazujący na `depcurfew.json`.
- **`packageManager: "npm@11.19.1"`** w `package.json`, czyli wersja npm z Node 24 LTS, na którym powstają wydania. `apply` i `doctor` liczą się z nią, a nie z najnowszą znaną wersją (zatwierdzona decyzja 3).
- **Wersja w `package.json`:** 1.0.0, repozytorium jest gotowe do wydania. Notę „pre-release” w README zmienię po publikacji (zatwierdzona decyzja 4).
- **`doctor` na sobie:**
  - kończy się kodem 0 z jednym ostrzeżeniem: `fsevents` (opcjonalny, tylko macOS) ma skrypt instalacyjny, którego npm nie uruchomi (zatwierdzona decyzja 5);
  - test `tests/meta/self-doctor.test.ts` pilnuje, że `apply` nie ma nic do zmiany, a `doctor` nie zgłasza błędów;
  - w CI `doctor` na sobie uruchamia zadanie `self` w `action-test.yml` (przez akcję), a przed etapowaniem także workflow wydania.

## D-048 · `lockfile-install-scripts` uwzględnia wyłącznik wszystkich skryptów (2026-10-29)
- **Skąd zmiana:** wyszła przy stosowaniu polityki na samym depcurfew. Przy npm 11.19.1 jeden ze spornych wariantów bazy mówi, że npm uruchamia skrypty z ostrzeżeniem, więc reguła zgłaszała błąd dla `fsevents`. Nie widziała `ignore-scripts=true` w `.npmrc`.
- **Zmiana:** reguła czyta teraz zweryfikowany wyłącznik `installScripts.disableAll` danego narzędzia (`ignore-scripts`, `ignoreScripts`, `enableScripts: false`, `install.ignoreScripts`) z jego pliku konfiguracyjnego. Gdy wyłącznik jest ustawiony, zgłoszenie ma poziom ostrzeżenia z informacją, co wyłącza skrypty. Niepewny wyłącznik Deno jest pomijany.
- **Fikstura:** `lockfile-install-scripts/fires-npm11-ignore-scripts`.

## D-049 · Fakty fazy 8 (2026-10-29)
- **Źródło:** oficjalna dokumentacja npm z repozytorium `npm/documentation`, przypięta do commita `514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b` (strony serwisu docs.npmjs.com są z tej sieci zablokowane).
- **Nowe fakty w `extra` npm:**
  - `trustedPublishing`: npm 11.5.1+, Node 22.14+, `id-token: write`, automatyczna proweniencja (tylko publiczna paczka z publicznego repozytorium), wygasanie nowej konfiguracji po 2 dniach;
  - `stagedPublishing`: npm 11.15.0+, polecenia `npm stage publish`, `approve` i `reject`, 2FA tylko przy zatwierdzaniu i odrzucaniu, wersja zastępcza `0.0.0-stage` dla nowej paczki, `--provenance` także przy etapowaniu;
  - `trustCommand`: `npm trust github`, paczka musi istnieć, flagi uprawnień.
- **Wersje i nazwa:** wersje npm w Node 24.22.2 (npm 11.19.1) i 22.23.4 (npm 10.9.9) pochodzą z `nodejs.org/dist/index.json`. Nazwa `depcurfew` była 2026-10-29 wolna (rejestr npm zwrócił 404).

## D-050 · Kryterium „wydanie 1.0.0 ma proweniencję” (2026-10-29)
- **Stan:** wymaga ręcznych kroków właściciela opisanych w `docs/RELEASING.md` (2FA, utworzenie paczki, trusted publisher, zakaz tokenów). Po nich, wyłącznie za osobną zgodą, wypchnę tag `v1.0.0`. Po zatwierdzeniu wydania z 2FA sprawdzę proweniencję w rejestrze (zatwierdzona decyzja 7).
- **Do tego czasu** faza 8 jest gotowa, ale niezamknięta.

## D-051 · Zatwierdzenie decyzji fazy 8 (2026-10-29)
- **Zatwierdzenie:** właściciel zaakceptował decyzje podjęte w trakcie fazy 8:
  - `lockfile-install-scripts` uwzględnia wyłącznik wszystkich skryptów (D-048);
  - utworzenie paczki przez etapowanie zostawia w jej historii publiczną wersję zastępczą `0.0.0-stage` (D-046);
  - `$schema` w `depcurfew.json` projektu wskazuje lokalny `./schema.json` do czasu publikacji;
  - komentarz o opóźnieniu w `.npmrc` zastąpił odnośnik do `depcurfew.json` (D-047);
  - zadanie CI na Node 22 używa npm 10.9.9, który nie zna nowych kluczy `.npmrc`; wydania idą przez Node 24 z npm 11.19.1 (D-046, D-047);
  - wydanie uruchamia każdy tag `vX.Y.Z` od osoby z prawem push; zalecana reguła ochrony tagów jest krokiem po stronie właściciela (`docs/RELEASING.md`);
  - nota „pre-release” w README zostaje do czasu publikacji 1.0.0.

## D-052 · Przegląd przed wydaniem 1.0.0 i poprawki (2026-10-29)
- **Zakres przeglądu:**
  - przegląd kodu całego `src/`, workflowów i `action.yml`;
  - osobny przegląd bezpieczeństwa z modelem zagrożeń „repozytorium jest niezaufane” (PR z forka w Action, sklonowane obce repo);
  - instalacja paczki z tarballa w czystym katalogu i wszystkie polecenia na 18 fiksturach na Node 22.0.0, 22.22 i 24.22.2.
- **Bez zastrzeżeń:**
  - workflowy: minimalne uprawnienia, akcje przypięte do SHA, brak `pull_request_target`;
  - brak wstrzyknięć w `action.yml`;
  - brak zanieczyszczania prototypów;
  - limit aliasów YAML;
  - parsery przy zagnieżdżeniu 200 000 poziomów;
  - zawartość paczki npm (9 plików).
- **Znalezione i poprawione (decyzje P1–P12 zatwierdzone przez właściciela):**
  - **Symlinki (P2):**
    - `depcurfew.json` jest czytany przez `Repository`, czyli nie przez symlink wychodzący poza repozytorium i nie powyżej 1 MiB (`src/policy/file.ts`);
    - `init --force` odmawia zapisu przez symlink i zapisuje przez plik tymczasowy;
    - Action odrzuca symlink w ścieżce pliku SARIF wewnątrz workspace'u, porównuje `directory` po `realpath` i czyta linie do SARIF przez `Repository`;
    - generatory sprawdzają istnienie i czytają pliki wewnątrz `guard`, więc symlink to zgłoszony błąd, a nie wywrotka.
  - **Odmowa przy wątpliwościach (P3):**
    - nowa reguła `unreadable-config` (błąd, bez polityki): plik, którego nie da się odczytać, sparsować albo zaplanować do edycji, w tym lockfile;
    - wcześniej takie przypadki były uwagami albo ginęły (ostrzeżenia detekcji), a `doctor` kończył się kodem 0;
    - jeden plik daje jedno zgłoszenie.
  - **Przełączniki „pozwól na wszystkie skrypty” (P4):** przy polityce `deny` npm komentuje ręczne `dangerously-allow-all-scripts` także bez listy dozwolonych. Komentarz bez bloku ma osobną notatkę („turned off; depcurfew.json manages this setting”).
  - **Edycja plików (P5, P10):**
    - mapy w stylu `{ ... }` w YAML: `apply` nie dopisuje do nich kluczy, tylko zgłasza błąd z wartością do wpisania ręcznie; skalary w środku dalej podmienia;
    - TOML: wartości wieloliniowe są komentowane w całości, a linie w tablicach i wieloliniowych stringach nie są brane za klucze ani nagłówki; `[[...]]` kończy tabelę;
    - TOML: `install` zdefiniowane kluczami z kropką albo tabelą inline to błąd zamiast drugiego nagłówka;
    - JSONC: przecinki końcowe są usuwane tylko poza stringami;
    - edycja JSON zachowuje komentarze przy usuwaniu elementów i wstawianiu do pustych kontenerów;
    - przy błędach `apply --dry-run` nie wypisuje diffu.
  - **Wersje (P6):** wersja przedpremierowa (`10.16.0-rc.1`) jest wcześniejsza niż wydanie, jak w semver; operatory ze spacją (`>= 10.0.0`) są rozpoznawane.
  - **DoS (P7):**
    - wzorce z `*` dopasowuje liniowy algorytm bez regexów (`src/detect/wildcard.ts`), który zastąpił wykładniczy backtracking;
    - kolejne `**` są łączone, a każda para katalogu i segmentu jest odwiedzana raz;
    - numery linii w lockfile'ach są liczone jednym przejściem.
  - **Zgodność `apply` i `doctor`:**
    - Dependabot: istniejące `semver-*-days` są podnoszone do polityki (P8); nazwy kluczy są w `cooldownKeys` w bazie wiedzy;
    - wpisy na listach dozwolonych z wersją (`esbuild@0.25.0`) są porównywane po nazwie (P9);
    - Renovate w kluczu `renovate` w `package.json` jest czytany, a podpowiedź nie odsyła do `apply` tam, gdzie `apply` nie edytuje pliku.
  - **Log Action (P11):** raport i błędy polityki są wypisywane między `::stop-commands::<losowy token>` a `::<token>::`. Fakt `githubActions.stopCommands` jest w bazie wiedzy ze źródłem.
  - **Lockfile npm:** wpis bez `resolved` npm instaluje jako `<nazwa>@<version>` (`reify.js`, `#extractOrLink`), więc źródło wynika z `version` (fakt `specWithoutResolved`). Źródło, którego depcurfew nie rozpoznaje, daje ostrzeżenie `lockfile-forbidden-source`, gdy polityka czegoś zabrania.
- **Ponowny przegląd poprawek (P12)** znalazł 10 drobniejszych problemów, wszystkie poprawione:
  - koniec tabeli TOML przy `[[...]]`;
  - podwójne zgłoszenie jednego pliku;
  - nazwy zaczynające się od `..` w Action;
  - podpowiedź dla `.renovaterc`;
  - odstępy w jednoliniowych tablicach JSON;
  - notatka bez bloku;
  - YAML w całości w stylu `{ ... }`;
  - trzy duplikaty kodu.
- **Testy:** 794, w tym nowe testy w `tests/security/` (symlinki, DoS), `tests/apply/review-*.test.ts` i nowe fikstury `doctor`.

## D-053 · Zatwierdzony plan fazy 7 (2026-10-29)
- **Kolejność (F1):** faza 7 po wydaniu 1.0.0, jako 1.1.0. Dodaje kod sieciowy, który dostanie osobny przegląd.
- **Polecenie (F1, F2):**
  - `depcurfew check <paczka>[@wersja|@tag|@zakres]... [--json] [--registry <url>]`;
  - sprawdza istnienie (404 to „możliwa wymyślona nazwa”), wiek wybranej wersji względem `cooldown` z `exclude`, skrypty `preinstall`/`install`/`postinstall` względem `installScripts`, podobieństwo nazwy do popularnej paczki i wycofanie (ostrzeżenie);
  - specyfikacje git, URL i `file:` sprawdza bez sieci względem `sources`;
  - kod 1 przy naruszeniu albo braku możliwości sprawdzenia.
- **Dane (F3):**
  - pełny dokument paczki z `GET /<nazwa>`, bo skrócony nie ma czasów publikacji;
  - wbudowany `fetch`, limit 15 s i 64 MiB, bez tokenów;
  - paczki z prywatnych rejestrów mają status „niesprawdzone”.
- **Podobne nazwy (F4):**
  - lista około 5000 najczęściej pobieranych paczek w `src/knowledge/` ze źródłem i datą, generowana skryptem z wyszukiwarki rejestru (pole `downloads.weekly`);
  - odległość edycyjna 1 dla nazw do 8 znaków, 2 dla dłuższych;
  - porównanie po usunięciu separatorów i scope'u.
- **Testy (F5):** nagrane i przycięte odpowiedzi rejestru w `tests/fixtures/registry/`, podmieniony `fetch` i stały zegar, bez sieci.
- **Hook (F6–F8):**
  - `depcurfew check --hook claude-code` czyta zdarzenie PreToolUse ze stdin i rozpoznaje instalacje oraz uruchamianie paczek w poleceniach Bash;
  - zwraca `deny` z powodem, a przy samym podobieństwie nazwy albo poleceniu nie do rozebrania zwraca `ask`;
  - przykład `.claude/settings.json` w README: forma exec i `onFailure: "block"`, z zastrzeżeniem, że hook to zabezpieczenie typu „best effort”;
  - bez `depcurfew.json` hook stosuje domyślną politykę z `init`.
- **MCP (F9):** nie w tej fazie. Protokół jest w przejściu na rewizję 2026-07-28, bez `initialize` i z `server/discover`. Agent może wołać `depcurfew check --json`.

## D-054 · Fakty fazy 7 (2026-10-29)
- **Rejestr npm** (`environment.npmRegistry`, źródło `npm/registry` `package-metadata.md` i `REGISTRY-API.md`):
  - pełny dokument z `GET /<nazwa>` (scope z `%2f`) z polami `dist-tags`, `versions`, `time`;
  - w obiekcie wersji `scripts` i `deprecated`, domyślny tag `latest`;
  - skrypty instalacji `preinstall`, `install`, `postinstall`;
  - 404 dla nieznanej nazwy (fakt niepewny, bo opis API ma pustą sekcję błędów);
  - wyszukiwarka zwraca najwyżej 250 wyników z polem `downloads.weekly`.
- **Hooki Claude Code** (`environment.claudeCode.hooks`, źródło code.claude.com/docs, nowa reguła w `ENVIRONMENT_SOURCES`): zdarzenie PreToolUse narzędzia Bash, pola wejścia i wyjścia, decyzje `deny`/`ask`, kod 2 blokuje, `onFailure: "block"` od 2.1.295, forma exec i `${CLAUDE_PROJECT_DIR}`.
- **Wiersz poleceń menedżerów** (`extra.commandLine`, `extra.valueOptions`):
  - npm: aliasy `install` i `exec` z `cmd-list.js` 12.2.1, `npx -c`/`--call` oraz opcje z wartością z `definitions.js`;
  - pnpm: `pnx`/`pnpx`/`pnpm dlx` z `--package` i `--shell-mode`, `pnpm create`, `-F` (z pnpm.io);
  - Yarn: `yarn dlx`, `yarn create` (z kodu `plugin-dlx`, bo nie ma go na yarnpkg.com), `yarn workspace <nazwa>`;
  - Bun: `bun add`, `bunx`/`bun x`, `bun create`;
  - Deno: `deno add`/`deno install` (z `denoland/docs`, bo docs.deno.com nie jest osiągalne z tej sesji).
- **Formy specyfikacji** (`extra.packageSpecs`):
  - npm (`npm-install.md`): git, `file:`, `npm:`, tarballe `.tar`/`.tar.gz`/`.tgz`, `user/repo`;
  - pnpm (`package-sources.md`): `link:`, `file:`, `workspace:`;
  - Yarn (`/protocols`): `link:`, `portal:`, `file:`, `workspace:`;
  - Bun (`add.mdx`): zapis scp `git@host:ścieżka`.
  - Każdy inny protokół (`jsr:`, `catalog:`, `patch:`, `crate:`, `pypi:` …) jest „niesprawdzony”, więc nie potrzebuje osobnego faktu.
- **Rejestry z konfiguracji:**
  - npm `registryConfig` (`definitions.js`): `registry`, `@scope:registry` i plik użytkownika `~/.npmrc`;
  - `registryOverrides` dla npm, pnpm (niepewny), Yarn i Bun: opcje i zmienne środowiskowe, które zmieniają rejestr albo plik konfiguracji.
- Fakty o wierszu poleceń zawierają tylko to, co dokumentacja pokazuje. Krótkie opcje Buna `-F` i `-c` dla `bun add` nie są w `valueOptions`, bo `bunx` ich nie dokumentuje, a opcja błędnie uznana za przyjmującą wartość ukryłaby paczkę za nią.

## D-055 · Skaner poleceń: zakres i model zagrożeń (2026-10-29)
- **Zakres.** Hook to zabezpieczenie przed pomyłkami i prostym maskowaniem, nie piaskownica. Nie widzi programu, który sam instaluje paczki (`node -e`, skrypt, `make`). Agent, który może pisać pliki, może też zmienić `depcurfew.json`, `.npmrc` albo wykonać `npm config set` w osobnym poleceniu. Prawdziwą ochroną pozostaje konfiguracja z `apply`, którą menedżery stosują przy każdej instalacji. README mówi to wprost.
- **Co skaner czyta jak powłoka:**
  - cudzysłowy, `$'...'`, here-documenty (ciało to dane, chyba że czyta je powłoka) i here-stringi;
  - `$(...)`, odwrotne apostrofy, `<(...)` oraz `${...:-$(...)}`;
  - arytmetykę `$((...))`, słowa zastrzeżone, `case` w `$(...)` i funkcje.
- **Co skaner śledzi:**
  - `sh -c` (także po opcjach z wartością `-o`/`-O`/`--rcfile`), `eval`, `env -S`, `su -c`, `npx -c`, `pnpm dlx -c`, `yarn workspace`;
  - wrappery `sudo`, `env`, `timeout`, `nice`, `xargs` (z `-I`) i inne;
  - menedżer paczek, powłokę albo wrapper dalej w słowach nieznanego polecenia (`strace`, `find -exec`, `npx cross-env … npm i`).
- **Niepewne przypadki dają `ask` (fail closed):**
  - słowa rozwijane przez powłokę w poleceniu instalacji, także globy i `{a,b}`;
  - polecenie złożone w całości z rozwinięcia wewnątrz ciągu poleceń (`eval "$CMD"`, `sh -c "$X"`);
  - powłoka czytająca polecenia z potoku albo pliku (`curl … | sh`);
  - niezamknięty nawias i zagnieżdżenie głębsze niż 4 poziomy;
  - opcja albo zmienna z `registryOverrides`, chyba że wskazuje publiczny rejestr.
- **Wybory zachowawcze:**
  - podkomenda dodająca paczki u któregokolwiek menedżera (np. `install`, `i`) jest sprawdzana u każdego;
  - podkomenda kończąca się `add` (`yarn global add`, `yarn workspaces foreach -A add`) też;
  - zastąpiło to stałą listę `install`/`i` w kodzie.
- **Poza zakresem:**
  - `update`/`up`/`upgrade` nie są sprawdzane: nazwy muszą już być zależnościami, wersję wybiera zakres z `package.json`, którego hook nie czyta, a aktualizacje i tak przechodzą przez opóźnienie zapisane przez `apply`;
  - `deno run npm:…` też nie jest sprawdzane.

## D-056 · Decyzje hooka i zachowanie przy błędach (2026-10-29)
- **`deny`:** zakazane źródło, nieistniejąca paczka, brak pasującej wersji, wersja młodsza niż `cooldown`, niedozwolone skrypty instalacji.
- **`ask`:** każdy inny błąd (podobna nazwa, rejestr nieosiągalny, prywatny rejestr scope'u, nieznany protokół) i polecenie nie do przeczytania.
- **Brak decyzji:** ostrzeżenia, np. wycofana wersja. Wtedy działa zwykły przepływ uprawnień Claude Code.
- **Paczka ze scope'em, której nie ma w rejestrze,** daje `ask`, a nie `deny`: scope może należeć do prywatnego rejestru ustawionego poza plikami, które depcurfew czyta.
- **Fail closed:**
  - zdarzenie, którego nie da się odczytać (zły JSON, stdin ponad 1 MiB), kończy się kodem 2 z faktu `blockingExitCode`, który blokuje wywołanie w każdej wersji Claude Code, także bez `onFailure`;
  - własny błąd depcurfew po odczytaniu zdarzenia daje `ask`;
  - błąd użycia (`--hook` z nieznaną nazwą) też kończy się kodem 2, więc blokuje.

## D-057 · Podobne nazwy: odejście od F4 (2026-10-29)
- **Lista:** 5000 najczęściej pobieranych paczek w `src/knowledge/popular.ts` (fakt niepewny, źródło: opis API rejestru).
  - Skrypt `npm run data:popular` wykonał 742 zapytania (około 370 haseł jako tekst i jako `keywords:`), pominął 50, które rejestr stale odrzucał, i widział 102 100 paczek.
  - Najrzadziej pobierana paczka na liście ma 3 758 933 pobrania tygodniowo.
  - Wyszukiwarka ignoruje `from`, więc lista jest przybliżeniem czołówki, nie dokładnym rankingiem.
- **Odejście od F4:** porównanie nazw z pominięciem scope'u zostało usunięte.
  - Na 818 paczkach opublikowanych 2026-10-29 uznawało `@any/cli` za podobne do `@angular/cli` i oznaczało 107 z nich (13%).
  - Odległość edycyjna i separatory oznaczyły 0.
  - Scope jest porównywany jako część nazwy.
- Nazwy krótsze niż 4 znaki nie są porównywane odległością edycyjną, bo jedna zmiana zamienia większość z nich w inną prawdziwą nazwę.

## D-058 · Rejestr i źródła w `check` (2026-10-29)
- **Wybór rejestru:**
  - paczki są szukane w rejestrze z `--registry`, potem w `registry=` z `.npmrc` projektu, potem z `~/.npmrc`, a na końcu w publicznym rejestrze;
  - `@scope:registry=` z obu plików oznacza paczki tego scope'u jako niesprawdzone (`ask`);
  - plik `.npmrc` jest czytany parserem INI z `doctor`.
- **URL bez rozszerzenia tarballa** może zostać sklonowany jako repozytorium git, więc jest sprawdzany względem `sources.remoteTarball` i `sources.git`. Zastąpiło to stałą listę hostów git w kodzie.
- `v1.2.3` i `1.2.3+build` wybierają wersję 1.2.3 jak w npm. Tagi są czytane tylko z własnych pól dokumentu, bez prototypu obiektu.
- **Równoległość:** najwyżej 6 zapytań naraz, kolejność raportów zgodna z kolejnością specyfikacji.

## D-059 · Przeglądy kodu fazy 7 (2026-10-29)
- **Przebieg:** trzy rundy przeglądu, po 10 ustaleń każda, wszystkie sprawdzone i poprawione. Wyjątki są opisane w D-055 jako poza zakresem.
  - Runda 1: podstawienia poleceń, słowa zastrzeżone, `eval`/`timeout`, `$'...'`, `bun add -p`, `yarn create`, fail closed hooka, równoległość, fakty spoza `src/knowledge/`.
  - Runda 2: apostrof w here-documencie, który ukrywał dalsze polecenia, here-string, `name@~`, `pnpm -F`, długie opcje wrapperów, `bash -O`, nadpisanie rejestru, `eval "$CMD"`, `yarn global add`, `v1.2.3`.
  - Runda 3: powłoka za innym poleceniem, `bun -c` i `YARN_RC_FILENAME`, `case` w `$(...)`, fałszywe `ask` przy `[ -f a ]`, zapis scp, `~/.npmrc`, Deno, tagi z prototypu, nazwy opcji spoza bazy wiedzy, drugi parser `.npmrc`.
- **Sprawdzenie na typowych poleceniach agenta** (git, testy, buildy, here-documenty w commitach, `npx tsc`): bez fałszywych `ask`.
- **Wydajność:** złośliwe wejście do 1,6 MB (zagnieżdżenia, cudzysłowy, here-documenty) jest skanowane w czasie poniżej 0,6 s.
## D-060 · Poprawki po testach na projektach przykładowych (2026-10-29)
Numer jest wyższy, bo D-054–D-059 należą do fazy 7 na gałęzi `faza-7` (wydanie 1.1.0).
- **Testy:** projekty przykładowe dla npm 12, pnpm 12 i 10, Yarn 4, Bun 1.4.4, Deno 2.9 i npm 11 z ręczną konfiguracją. depcurfew był instalowany z tarballa (`npm pack`), a w każdym projekcie sprawdzałem, czy menedżer naprawdę egzekwuje to, co zapisał `apply`.
- **pnpm 12 (lockfile z dwoma dokumentami).**
  - Gdy projekt przypina pnpm 12 albo nowszy, ma zależności konfiguracji albo `devEngines.packageManager`, pnpm zapisuje najpierw dokument rozruchowy, a po nim właściwy lockfile. Plik zaczyna się wtedy od `---`.
  - `doctor` czytał plik jako jeden dokument i zgłaszał `unreadable-config` w każdym takim projekcie.
  - Teraz czyta ostatni dokument (fakt `lockfileDocuments`, źródło: pnpm.io `docs/lockfile.md`), a numery linii liczy od jego początku.
- **Bun (wbudowana lista zaufanych paczek).**
  - Przy `installScripts.default: deny` i pustej liście `allow` depcurfew nic nie zapisywał. Bun nadal uruchamiał wtedy skrypty paczek ze swojej wbudowanej listy: postinstall esbuild wykonał się w Bun 1.4.4.
  - Teraz `apply` zapisuje `"trustedDependencies": []`, co zastępuje wbudowaną listę; test potwierdził blokadę.
  - Istniejąca lista nie jest zmieniana, poza dopisaniem paczek z polityki.
- **npm 11.16–11.x (skrypty z ostrzeżeniem).**
  - Spór w bazie wiedzy jest rozstrzygnięty. Definicja `strict-allow-scripts` w npm 11.16.0 i test na npm 11.21.1 pokazują, że skrypty nieobjęte `allowScripts` działają z ostrzeżeniem: postinstall esbuild wykonał się i podmienił `bin/esbuild` na binarkę.
  - Decyzja właściciela (wariant a): dla przypiętego npm od 11.16 do wersji poniżej 12 `apply` zapisuje `strict-allow-scripts=true`. Instalacja paczki z niezatwierdzonym skryptem kończy się wtedy błędem.
  - Dla npm poniżej 11.16, który nie ma listy dozwolonych, `apply` ostrzega, że zakazu nie da się wyegzekwować.
  - `lockfile-install-scripts` traktuje `strict-allow-scripts` jak blokadę.
  - Przy nieprzypiętej wersji depcurfew konfiguruje pod najnowszą znaną (npm 12), jak dotąd.
- **Repozytorium depcurfew** przypina npm 11.19.1, więc jego `.npmrc` dostał `strict-allow-scripts=true`. `ignore-scripts=true` nadal ma pierwszeństwo.
- **Macierz wersji (druga runda).** 26 wersji, każda w czystym projekcie. Sprawdzone: `init`, `apply`, drugie `apply` bez zmian i `doctor`, a następnie prawdziwe instalacje: wersji sprzed 4 godzin, esbuild ze skryptem `postinstall` i paczki z gita.
  - npm: 11.9.0, 11.10.0, 11.16.0, 11.21.1, 12.0.0, 12.2.1.
  - pnpm: 10.15.0, 10.16.0, 10.26.0, 10.34.9, 11.0.0, 11.28.9, 12.0.0, 12.16.1.
  - Yarn: 4.9.4, 4.10.1, 4.10.2, 4.11.0, 4.12.0, 4.14.0, 4.18.1.
  - Bun: 1.2.23, 1.3.0, 1.4.4.
  - Deno: 2.5.4, 2.5.5, 2.6.0, 2.9.6.
- **pnpm 11.0.0–11.0.3 i 12.0.0–12.2.x** domyślnie nie są ścisłe: zainstalowały wersję sprzed 4 godzin, a 12.0.0 dopisał ją do `minimumReleaseAgeExclude`. Od 11.0.0 `apply` zapisuje `minimumReleaseAgeStrict: true` (źródło: pnpm.io dependency-resolution). Po zmianie obie wersje ją odrzucają.
- **pnpm 10.16.x** pomija opóźnienie dla paczek zamawianych w dokładnej wersji; poprawił to 10.17.0 (changelog). `apply` ostrzega, a `manager-version-too-old` zgłasza to jako brak „minimumReleaseAge for packages requested by exact version (since 10.17.0)”. Komunikat pomija tę lukę, gdy brakuje całego ustawienia.
- **Yarn: `npmMinimalAgeGate` od 4.10.2.** Spór 4.10.0 albo 4.12.0 jest rozstrzygnięty testem: 4.10.1 z tym ustawieniem odrzucał też wersje sprzed ponad roku, a 4.10.2 („Bust the metadata cache”, poprawka danych bez czasu publikacji), 4.10.3, 4.11.0 i 4.12.0 działają poprawnie. depcurfew wpisuje ustawienie od 4.10.2, a dla starszych wersji `doctor` zgłasza za starą wersję.
- **Wynik macierzy:**
  - Każda wspierana wersja odrzuca zbyt świeżą wersję i blokuje skrypty: Bun od 1.3.0 dzięki pustemu `trustedDependencies`, npm 11.16+ przez `strict-allow-scripts`; Deno bez `allowScripts` skryptów nie uruchamia.
  - Git jest blokowany tam, gdzie menedżer ma odpowiednie ustawienie: npm od 11.10, Yarn od 4.14.
  - Drugie `apply` nigdy nic nie zmienia.
  - Kod 1 z `doctor` dają tylko wersje, którym naprawdę brakuje ustawienia, i każda jest nazwana.
- **Yarn Classic (1.x):** `apply` ostrzegał, że nic nie zapisze, ale `doctor` kończył się kodem 0, więc polityka po cichu nie działała. Teraz `manager-version-too-old` zgłasza błąd, gdy jest polityka, i podaje wersję Yarna, od której depcurfew konfiguruje opóźnienie (4.10.2).

## D-061 · Komunikaty dla ludzi i maszyn, kolory, pomoc poleceń, Action poza logiem (2026-10-29)

- **Zasada.** Tekst jest dla człowieka: jeden język (angielski), pełne zdania i przy każdym błędzie i ostrzeżeniu informacja, co zrobić. Programy i agenci AI czytają `--json` i `--sarif`. Te formaty się nie zmieniają, poza tym, że więcej znalezisk ma pole `fix`.
- **Wskazówki.**
  - Każde znalezisko `doctor` ma `fix`; `config-drift` mówi, czy uruchomić `depcurfew apply`, czy zmienić `depcurfew.json`.
  - Każde ostrzeżenie `apply` kończy się działaniem: wymaganą wersją narzędzia, miejscem, gdzie przypiąć wersję, ustawieniem w polityce do zmiany albo informacją, że `doctor` nadal pilnuje lockfile'a.
  - Brakujące ustawienia jednej wersji narzędzia są w jednym ostrzeżeniu, pogrupowane według wersji (`src/apply/requirements.ts`). Ta sama funkcja opisuje braki w `manager-version-too-old`.
- **Pisownia:** amerykańska (recognize, honors, behavior) i zwykły apostrof `'` zamiast typograficznego.
- **Pomoc.** `depcurfew <polecenie> --help`, `-h` i `depcurfew help <polecenie>` opisują polecenie: co robi, jakie ma opcje, przykłady i kody wyjścia. Błąd użycia odsyła do pomocy tego polecenia.
- **Kolory.**
  - Własny moduł `src/color.ts` z kodami ANSI, bez nowej zależności.
  - Kolory są tylko na terminalu (osobno dla stdout i stderr) i nie dla `TERM=dumb`. `NO_COLOR` z niepustą wartością je wyłącza. `FORCE_COLOR` ma pierwszeństwo, jak w Node.js: `0` i `false` wyłączają, każda inna wartość włącza.
  - JSON, SARIF i diff przekierowany do pliku nigdy nie dostają kodów. Testy sprawdzają, że po usunięciu kodów tekst jest identyczny z wersją bez kolorów.
- **GitHub Action.**
  - Log pozostaje zwykłym tekstem w bloku `stop-commands`.
  - Doszły adnotacje (`::error`/`::warning`/`::notice` z plikiem, linią i poprawką) i tabela w podsumowaniu zadania (`GITHUB_STEP_SUMMARY`). Obie można wyłączyć wejściami `annotations` i `job-summary`.
  - Nowe fakty w bazie wiedzy:
    - `annotations`: składnia i escapowanie jak `escapeData`/`escapeProperty` w @actions/core;
    - `annotationLimits`: 10 na poziom na krok, 50 na zadanie (problem-matchers.md);
    - `stepSummary`: zmienna i limit 1 MiB (dokumentacja workflow commands).
  - Tekst z repozytorium jest escapowany, więc spreparowana nazwa pliku nie doda polecenia przepływu pracy ani w Markdownie linku, HTML-a czy komórki tabeli. Wiersze, które przekroczyłyby limit podsumowania, są pomijane i liczone.
- **GitLab i inne CI.** Action działa tylko na GitHubie. Na innym CI uruchamia się CLI (od D-063: kopia z projektu, `npm ci`, potem `npx depcurfew doctor`). Format raportu GitLaba nie jest obsługiwany: wymagałby najpierw zweryfikowanych faktów.
- **Pozycje spoza polityki na listach dozwolonych.** `apply` dopisuje do list, ale z nich nie usuwa (zasada z CLAUDE.md). Dlatego ostrzega o każdej paczce, na którą lista pozwala, a polityka nie: podaje plik, ustawienie i dwie drogi naprawy. Korzysta z tego samego odczytu list co `config-drift` (`src/doctor/allow-lists.ts`).
- **`check` i hook (faza 7).**
  - Każde znalezisko `check` ma pole `fix`, w tekście jako wiersz `fix:`, a w `--json` jako pole.
  - Hook przekazuje agentowi tylko te poprawki, które nie zmieniają `depcurfew.json`, i dopisuje, że politykę zmienia wyłącznie użytkownik. Agent nie powinien obchodzić strażnika edycją polityki.
  - Informacja o domyślnej polityce zaczyna się od `note:`, bo to nie jest błąd.

## D-062 · Nowa nazwa: depcurfew i krótkie polecenie dcf (2026-10-29)

- **Powód.** Nazwę `depgate` od września 2025 nosi inne narzędzie z tej samej branży: DepGate autorstwa cognitivegears (PyPI `depgate`, GitHub `cognitivegears/depgate`, zakres npm `@depgate`). Wykrywa dependency confusion i ma bramkę wieku wydania. Groziło to pomyleniem narzędzi, sporem o nazwę w npm i kłopotem z rejestracją znaku towarowego. Nazwę zmieniamy przed 1.0.0, bo jest to najtańszy moment: nikt jeszcze nie używa `depgate.json` ani Action.
- **Wybór (decyzja właściciela).** `depcurfew`, czyli „godzina policyjna dla zależności”. W dniu decyzji nazwa była wolna:
  - w npm (paczka i zakres), w PyPI i w crates.io;
  - na GitHubie nie było repozytorium ani użytkownika o tej nazwie;
  - wyszukiwarka nie zwracała żadnych wyników.
- **Odrzucone kandydatki:**
  - depfence, lockward, pkgward, depward(en), installgate, supplyward(en), pinward: istnieją narzędzia o tych nazwach z tej samej branży;
  - depmoat: kojarzy się z LavaMoat i laravel/moat;
  - depcordon: nazwa „cordon” jest zatłoczona wśród narzędzi do bezpieczeństwa agentów AI.
- **Nie sprawdzone w tej sesji:** rejestry znaków towarowych (TMview) i domeny, bo te serwisy były niedostępne. Sprawdza je właściciel.
- **Zakres zmiany.** Zmieniły się:
  - nazwa paczki i polecenia;
  - plik polityki `depcurfew.json`;
  - znaczniki zarządzanych fragmentów (`# >>> depcurfew managed block`, `# managed by depcurfew`);
  - adres schematu `https://unpkg.com/depcurfew/schema.json`;
  - paczka Action `action/depcurfew.mjs`;
  - adres repozytorium `DevXord/depcurfew` (repozytorium na GitHubie zmienia nazwę właściciel).

  Starych nazw nie obsługujemy, bo wersja z nazwą `depgate` nigdy nie została wydana.
- **Krótkie polecenie `dcf`.** Drugi wpis w `bin`, wskazujący ten sam plik. Paczka npm `dcf` instaluje polecenie `dcf-shell`, a nie `dcf`, i nie ma polecenia systemowego o tej nazwie. Pomoc i komunikaty używają pełnej nazwy; pomoc ogólna mówi o skrócie.


## D-063 · Tarball z URL na hoście rejestru w lockfile npm; instalacja w projekcie zamiast globalnej (2026-10-29)

- **Luka.** W `package-lock.json` zależność zadeklarowana jako adres tarballa na hoście rejestru wyglądała jak zwykła paczka z rejestru. Na przykład `left-pad@https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz` ma ten sam `resolved` co paczka zainstalowana zakresem. `lockfile-forbidden-source` jej nie zgłaszał.
  - npm traktuje taki adres jako źródło zdalne. Blokuje go `allow-remote=none` (`EALLOWREMOTE`, sprawdzone na npm 11.21.1), ale `min-release-age` go nie obejmuje.
  - Agent AI mógł więc przypiąć świeżą wersję z pominięciem opóźnienia, jeśli polityka nie była jeszcze zastosowana. Do tej pory `doctor` o tym milczał.
- **Poprawka.** Odczyt lockfile npm zbiera adresy URL zadeklarowane w polach zależności wpisów (fakt `dependencyFields`: `dependencies`, `optionalDependencies` i `peerDependencies` każdej paczki oraz `devDependencies` projektu; źródło: shrinkwrap.js w npm/cli). Wpis, którego `resolved` jest jednym z tych adresów, ma źródło `remoteTarball`, także na hoście rejestru.
- **Pozostałe menedżery** (sprawdzone na prawdziwych lockfile'ach):
  - Yarn 4.18.1 i Bun 1.4.4 już zapisywały taki adres jako tarball i były zgłaszane;
  - npm 12 domyślnie odmawia instalacji (`allow-remote`);
  - pnpm (10.34.9 i 12.16.1) rozwiązuje adres pod skonfigurowanym rejestrem jako paczkę z rejestru o tej wersji (`parseBareSpecifier.ts`). Nie pobiera więc z adresu z pominięciem rejestru i nie jest to zgłaszane. Fikstura `passes-pnpm-registry-tarball-url` utrwala to zachowanie.
- **Instalacja.** README zaleca depcurfew jako zależność deweloperską projektu, przypiętą w lockfile i instalowaną pod opóźnieniem projektu.
  - Programiści nie muszą go instalować, bo ochronę daje zapisana konfiguracja.
  - Inne CI uruchamia kopię z projektu (`npm ci`, potem `npx depcurfew doctor`) zamiast `npx --yes depcurfew@1`, które pobierało najnowszą wersję bez opóźnienia.
  - Instalacja globalna działa, ale nie jest polecana zespołom: wersje się rozjeżdżają, a npm nie czyta `.npmrc` projektu w trybie globalnym (fakt `npmrcScope.globalMode`).
- **Plan.** `dcf apply --user` (ochrona całego komputera programisty) i ostrzeżenie o starszej wersji wchodzą do planu jako faza 8b, wersja 1.2.0.
- **Po przeglądzie kodu (PR #11).**
  - **Dopasowanie po ścieżce, nie po tekście adresu.** Zależność z URL jest przypisywana wpisowi tak, jak Node szuka paczki: najpierw `node_modules` deklarującego pakietu, potem rodziców. Nie porównujemy tekstu adresu z `resolved`, bo npm przy domyślnym `replace-registry-host=npmjs` może zapisać tam host skonfigurowanego rejestru. Kopia tej samej paczki osiągnięta przez zakres wersji nie jest oznaczana.
  - **`overrides` z URL.** Nie trafiają do lockfile, więc są czytane z `package.json` obok lockfile (nowy fakt `overrides`; zagnieżdżenia i klucz `.`). Wpis tej paczki, którego ścieżka w `resolved` kończy się ścieżką adresu, ma źródło `remoteTarball`.
  - **README:**
    - inne CI instaluje zależności z `--ignore-scripts`, żeby nic z lockfile nie uruchomiło się przed `doctor`;
    - `npx --no` zamiast samego `npx`, bo w CI npx bez pytania pobrałby najnowszą wersję;
    - opóźnienie obejmuje aktualizacje depcurfew dopiero po pierwszym `apply`.
  - Test pilnuje, że zdanie README o trybie globalnym zgadza się z faktem `npmrcScope.globalMode`.

