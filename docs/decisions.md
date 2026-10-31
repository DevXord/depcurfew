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
- **Kolejność (F1):** faza 7 po wydaniu 1.0.0, jako 1.1.0. Dodaje kod sieciowy, który dostanie osobny przegląd. (D-068: 1.1.0 obejmuje też fazę 10.)
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
- **Plan.** `dcf apply --user` (ochrona całego komputera programisty) i ostrzeżenie o starszej wersji wchodzą do planu jako faza 11, wersja 1.3.0 (po fazie 10 z Pythonem w 1.2.0). Zmienione w D-068: Python wchodzi do 1.1.0, a faza 11 to 1.2.0.
- **Po przeglądzie kodu (PR #11).**
  - **Dopasowanie po ścieżce, nie po tekście adresu.** Zależność z URL jest przypisywana wpisowi tak, jak Node szuka paczki: najpierw `node_modules` deklarującego pakietu, potem rodziców. Nie porównujemy tekstu adresu z `resolved`, bo npm przy domyślnym `replace-registry-host=npmjs` może zapisać tam host skonfigurowanego rejestru. Kopia tej samej paczki osiągnięta przez zakres wersji nie jest oznaczana.
  - **`overrides` z URL.** Nie trafiają do lockfile, więc są czytane z `package.json` obok lockfile (nowy fakt `overrides`; zagnieżdżenia i klucz `.`). Wpis tej paczki, którego ścieżka w `resolved` kończy się ścieżką adresu, ma źródło `remoteTarball`.
  - **README:**
    - inne CI instaluje zależności z `--ignore-scripts`, żeby nic z lockfile nie uruchomiło się przed `doctor`;
    - `npx --no` zamiast samego `npx`, bo w CI npx bez pytania pobrałby najnowszą wersję;
    - opóźnienie obejmuje aktualizacje depcurfew dopiero po pierwszym `apply`.
  - Test pilnuje, że zdanie README o trybie globalnym zgadza się z faktem `npmrcScope.globalMode`.

## D-064 · Marka zamiast danych autora tam, gdzie to możliwe; README gotowe na stronę npm (2026-10-29)

- **Zasada (decyzja właściciela).** Programista nie musi wpisywać w plikach swojego projektu niczego z danymi autora. Tam, gdzie nazwę właściciela wymaga GitHub albo npm, zostaje `DevXord`. Organizacja GitHub nie jest potrzebna.
- **Wymagane:**
  - wiersz `uses: DevXord/depcurfew@<SHA>` w workflow użytkownika, bo GitHub buduje go z właściciela repozytorium;
  - `repository` w `package.json`, bo npm porównuje go przy proweniencji z repozytorium, z którego zbudowano paczkę (stąd też `homepage` i `bugs`);
  - trusted publisher w `docs/RELEASING.md`;
  - `LICENSE`: „Copyright (c) 2026 DevXord”. Informacja o prawach autorskich nikomu nie przeszkadza, bo nikt jej nie wpisuje we własne pliki, a jednoznacznie wskazuje właściciela praw.
- **Marka zamiast danych autora:**
  - `author: depcurfew` w `package.json` i `action.yml`;
  - `informationUri` w SARIF wskazuje stronę paczki na npm, więc wyniki code scanning u użytkownika nie wskazują konta autora.
- **Pliki zapisywane w projektach użytkowników:** `depcurfew.json` (`$schema` na unpkg.com/depcurfew) i znaczniki zapisywane przez `apply` od początku zawierały tylko markę.
- **Poza kodem:** rejestr npm pokazuje publicznie nazwę i mail opiekuna paczki (pole `maintainers`), a historia commitów na GitHubie — dotychczasowych autorów.
- **README na stronie npm.** npm pokazuje README z opublikowanej paczki, więc nota „pre-release” i instrukcja „until the package is published” znikają przed tagiem `v1.0.0`, nie po nim.

## D-065 · Python: nazwy z prefiksem `pypi:`, budowanie ze źródeł jako `installScripts` (2026-10-30)

- **Decyzja właściciela.** Obie części wybrał właściciel spośród przedstawionych wariantów.
- **Nazwy paczek.** Paczki Pythona w `cooldown.exclude` i `installScripts.allow` mają prefiks `pypi:` (`"pypi:docopt"`, `"pypi:acme-*"`). Nazwy bez prefiksu dotyczą tylko npm, tak jak w 1.0, więc znaczenie istniejących plików się nie zmienia.
  - Powód: ta sama nazwa w npm i PyPI to dwie różne paczki. Zgoda na npm-owe `esbuild` nie może obejmować paczki `esbuild` z PyPI.
  - Inne prefiksy (`npm:`, `PyPI:`) są błędem z podpowiedzią. Nazwy Pythona porównujemy po normalizacji z PEP 503.
  - Przy okazji nazwy npm mogą zawierać `_` (np. `string_decoder`), co wcześniej było błędem gramatyki.
- **Kto widzi które nazwy.**
  - Generatory menedżerów, reguły `doctor` i `check` dostają widok polityki swojego rejestru (`policyFor`).
  - Dependabot: każdy wpis `updates` dostaje wyjątki swojego rejestru (`npm`, `bun`, `deno`: nazwy npm; `pip`, `uv`: nazwy `pypi:`).
  - Renovate: reguła z nazwami npm zostaje bez zmian, czyli bez `matchDatasources`, jak w 1.0. Nazwy `pypi:` trafiają do osobnej reguły z `matchDatasources: ["pypi"]`. Ograniczenie: nazwy npm w regule Renovate nadal obejmują wszystkie źródła; zawężenie do `npm` wymagałoby faktów o źródłach JSR w menedżerze Deno.
- **`installScripts` w Pythonie oznacza budowanie ze źródeł.** Budowanie sdist, repozytorium git albo katalogu uruchamia backend budowania, czyli kod paczki. Instalacja koła (wheel) nie uruchamia kodu. `default: "deny"` to zakaz budowania:
  - uv: `no-build = true`;
  - Poetry: `installer.only-binary = [":all:"]` (od 2.0.0);
  - pip: `--only-binary=:all:` w `requirements.txt`, bo pip nie ma konfiguracji projektu.
- **Lista `allow`.** Żadne z trzech narzędzi nie ma ustawienia „tej paczce wolno budować”. Ma tylko wyjątek od zakazu, który wymusza budowanie danej paczki ze źródeł przy każdej instalacji, nawet gdy jest koło: uv `no-binary-package`, Poetry `installer.no-binary` (wyjątek działa od 2.2.0), pip `--no-binary`.
  - Decyzja: zapisujemy zakaz i wymuszone wyjątki, z ostrzeżeniem, co to znaczy. Zgody potrzebują zwykle paczki bez kół, a dla nich nic się nie zmienia; `doctor` wskaże je w lockfile'u.
  - Poetry przed 2.2.0: paczka z obu list nie ma pliku do instalacji, więc wyjątków nie zapisujemy i ostrzegamy.
- **Czego zakaz nie obejmuje.** Poetry i pip budują zależności z gita, katalogów i URL mimo zakazu, a Poetry może budować sdist już przy rozwiązywaniu zależności. uv z `no-build = true` odmawia też gita i lokalnych katalogów (poza członkami workspace'u), co sprawdziłem na uv 0.13.6. Zakres przełącznika zapisuje fakt `buildSwitch.covers`. Zależności spoza zakresu pilnuje sekcja `sources` (żadne narzędzie nie ma ustawienia, które ich zabrania) oraz `doctor` na lockfile'u.
- **Macierz prawdziwych wersji (2026-10-30).** Za stara wersja nie kończy się błędem, tylko po cichu wyłącza ochronę:
  - uv 0.9.16 nie rozumie okresu w `exclude-newer`, ostrzega i rozwiązuje bez opóźnienia;
  - uv 0.9.17 z wyjątkiem `= false` (dopiero od 0.9.25) ignoruje całe `[tool.uv]`;
  - Poetry 2.3.4 bez słowa ignoruje `solver.min-release-age`;
  - pip 25.3 bez słowa ignoruje `PIP_UPLOADED_PRIOR_TO`, a pip 26.0 przyjmuje tylko daty.

  Dlatego `apply` pisze ustawienie tylko dla wersji, która je zna, a `doctor` (`manager-version-too-old`) zgłasza za stare wersje przypięte w projekcie. Projekty testowe miały wyłącznie paczki z kołami, więc nic nie było budowane ani uruchamiane.
- **Nowa reguła `python-config-ignored`.** Wykrywa ustawienia Pythona zapisane tam, gdzie narzędzie ich nie czyta: `[tool.uv]` obok `uv.toml`, ustawienia uv w członkach workspace'u, `pip.conf` w projekcie, opcje odrzucane przez pip w `requirements.txt` oraz datę w `exclude-newer`, która zamraża zależności.

## D-066 · Poprawki po przeglądzie fazy 10 (2026-10-30)

- **Klucze `__proto__` w TOML.** Czytnik zapisuje klucze jako własne właściwości (`Object.defineProperty`) i odczytuje tylko własne (`Object.hasOwn`). `__proto__` i `constructor` w pliku są zwykłymi danymi, jak w `tomllib` i uv.
  - Wcześniej `source = { __proto__ = { registry = … }, git = … }` w `uv.lock` ukrywało zależność z gita przed `doctor`.
  - Zapis `__proto__.x = …` zmieniał `Object.prototype` w całym procesie.
- **Pliki dołączane w requirements.** `doctor` czyta pliki z `-r` i `-c`, tak jak pip, czyli względem pliku, który je dołącza. Opcje globalne (np. `--only-binary`) z całego drzewa dotyczą wszystkich paczek.
  - Dołączenie, którego nie da się przeczytać (URL, brak pliku, ścieżka poza repozytorium), to błąd `unreadable-config`: fail closed.
  - Sprawdzanie biegnie razem z regułami lockfile'ów, czyli gdy polityka ma `sources` albo `installScripts.default: "deny"`.
- **Ścieżki w requirements jak w pip.** Wymaganie z separatorem ścieżki albo zaczynające się od `.` to ścieżka, a nazwa z rozszerzeniem archiwum to plik, także bez `./`. Rozszerzenia, schematy URL i fragment `#egg=` pochodzą z bazy wiedzy (`requirementsPaths`, `requirementsFormat`).
- **`required-version` tylko z pliku, który uv czyta.** Gdy jest `uv.toml`, wersja z `[tool.uv]` nie jest przypięta: uv ją pomija i sam o tym ostrzega.
- **`uv lock` po `apply`.** `uv.lock` zapisuje w `[options]` ustawienia `exclude-newer` i `exclude-newer-package` (fakt `lockedSettings`). Gdy `apply` je zmienia, a `uv.lock` istnieje, ostrzega, że trzeba uruchomić `uv lock`, bo inaczej `uv sync --locked` i `uv lock --check` kończą się błędem. `no-build` nie trafia do lockfile'u, więc jego zmiana nie wymaga ponownego blokowania.
- **Fail closed dla TOML w `doctor`.** Reguły czytają TOML przez `Repository.parseOnce`, więc błąd składni (np. dwa razy `[solver]` w `poetry.toml`) trafia do `unreadable-config`. Wykrywanie i `doctor` mają jedną pamięć podręczną zamiast dwóch.
- **Workspace przy nieczytelnym pliku deklaracji.** Jak w 1.0: gdy `deno.json` się nie parsuje, workspace może pochodzić z `deno.jsonc`.
- **Nazwane pliki pylock.** `pylock.<nazwa>.toml`, który dopuszcza specyfikacja, jest wykrywany. Nazwa pliku projektu Pythona (`pyproject.toml`) pochodzi z bazy wiedzy.
- **Usunięcie bloku w środku pliku.** `removeBlock` zdejmuje pustą linię wstawioną przed blokiem także wtedy, gdy po bloku stoi pusta linia, więc plik wraca do oryginału. Dotyczyło to też `bunfig.toml` w 1.0.0.
- **Komunikaty dla człowieka i dla AI.** Stałe zasady są w CLAUDE.md (sekcja „Komunikaty”). Brakujące `apply --json` z kodami ostrzeżeń to osobne zadanie.

## D-067 · `apply --json` i kody ostrzeżeń (2026-10-30)

- **Kody.** Każde ostrzeżenie i błąd `apply` ma stały kod w kebab-case. Katalog `APPLY_WARNINGS` i `APPLY_ERRORS` w `src/apply/warnings.ts` daje do każdego kodu jedno zdanie opisu, z którego powstaje sekcja README (`apply-codes`). Test pilnuje, że każdy kod z katalogu jest użyty w kodzie, a TypeScript, że kod spoza katalogu się nie skompiluje.
- **Ostrzeżenie** to `{ code, tool, location?, message, fix? }`, jak znalezisko `doctor`. `message` mówi, co się stało, a `fix` (gdy jest co zrobić) co zrobić. Ostrzeżenia czysto informacyjne, np. o ustawieniu, które `apply` samo przełączyło, nie mają `fix`.
- **Tekst dla człowieka** wygląda jak w `doctor`: `warning: <message> (<kod>)`, a w następnej linii `fix: <co zrobić>`. Kod jest przygaszony, `fix:` zielone. Błąd ma tę samą postać, np. `error: … (cannot-edit)` i `fix:`. Liczba i kolejność ostrzeżeń w fiksturach się nie zmieniła; zmienił się tylko podział na komunikat i poprawkę.
- **`apply --json`** (także z `--dry-run`) wypisuje na stdout jeden dokument, a stderr zostaje pusty:
  - `schemaVersion: 1`, `policy` (`valid`, `missing`, `invalid`), `dryRun`, `written`;
  - `changes`: plik, `action` (`create` albo `update`) i diff unified;
  - `warnings` i `errors`: `code`, `level`, narzędzie, plik, `message`, `fix`, a przy błędnej polityce także `issues`;
  - `snippets` i `summary`.

  Gdy jest błąd, `changes` jest puste, bo `apply` nic nie zapisze; kod wyjścia jest taki sam jak w trybie tekstowym. Brak albo błąd `depcurfew.json` też daje dokument JSON (kody `policy-missing`, `policy-invalid`, `policy-unreadable`), a nie tekst na stderr.
- **Zgodność wsteczna.** `ApplyReport.warnings` zostaje listą napisów (`message` i `fix` w jednej linii). Szczegóły są w nowym polu `warningDetails`, tak jak `errors` i `failures`. `PolicyError` dostaje `code`, `fix` i `text`. Publiczne API eksportuje też `APPLY_WARNINGS`, `APPLY_ERRORS`, `warningText` i typy `ApplyWarning`, `ApplyWarningCode`, `ApplyErrorCode`.
- **TOML, który się nie parsuje, nie jest edytowany.** Blok TOML jest pisany liniami, więc wcześniej `apply` dopisywało go do zepsutego pliku i zgłaszało sukces (także `bunfig.toml` w 1.0.0). Teraz plik musi się parsować przed edycją i po niej; inaczej to błąd `cannot-edit` i nic nie zostaje zapisane, jak przy JSON i YAML. Wyszło przy pokazie `apply --json` na projekcie testowym.
- **Poza zakresem.** `doctor --json` przy błędnej polityce nadal pisze tekst na stderr; ujednolicenie to osobne zadanie.

## D-068 · Jedno wydanie 1.1.0 zamiast 1.1.0 i 1.2.0 (2026-10-30)

- **Decyzja właściciela.** Faza 7 (`check` i hook Claude Code), faza 10 (Python: uv, pip, Poetry) oraz `apply --json` z kodami ostrzeżeń wychodzą razem jako 1.1.0, po wydaniu 1.0.0.
- **Powód.** Faza 10 powstała na gałęzi `faza-7` i została do niej scalona (#14, razem z #15). PR #6 (`faza-7` → `main`) zawiera więc obie fazy, a osobne 1.1.0 bez Pythona wymagałoby rozdzielania gałęzi.
- **Nowa kolejność wydań:**
  - 1.0.0: `init`, `explain`, `apply`, `doctor`, GitHub Action; npm, pnpm, Yarn, Bun, Deno, Renovate, Dependabot;
  - 1.1.0: `check` i hook, Python (uv, pip, Poetry), `apply --json`;
  - 1.2.0: `dcf apply --user` i `dcf doctor --user` (faza 11, wcześniej 1.3.0);
  - 2.x: kolejne języki (faza 12).
- **Zastępuje** kolejność z F1 (D-060) i z planu przy D-063. Wcześniejsze wpisy zostają bez zmian jako historia, z odsyłaczem do tej decyzji.

## D-069 · Błędna polityka w `doctor` jako znalezisko `invalid-policy` (2026-10-30)

- **Problem.** `doctor --json` i `--sarif` przy błędnym albo nieczytelnym `depcurfew.json` pisały tekst na stderr i nic na stdout, więc program albo agent AI nie dostawał dokumentu do odczytania (D-067, „Poza zakresem”).
- **Decyzja.** Nowa reguła `invalid-policy` (poziom `error`, nie wymaga polityki) zgłasza problemy jak każde inne znalezisko: położenie `depcurfew.json`, w komunikacie wszystkie problemy ze schematu, a w `fix` co zrobić. Tekst, `--json` i `--sarif` pokazują to samo, z jednego źródła.
  - Jak bez pliku polityki, działają reguły, które jej nie potrzebują; uwaga mówi, że polityka jest błędna.
  - JSON ma `policy: "invalid"`, a `summary.error` liczy to znalezisko, więc odbiorca, który czyta tylko znaleziska, też widzi błąd. Kod wyjścia 1, jak wcześniej.
- **Biblioteka bez zmian.** `runDoctor` domyślnie nadal rzuca `PolicyError`, zgodnie z publicznym API. Opcja `invalidPolicy: "report"` (używa jej CLI) daje raport zamiast wyjątku.
- **GitHub Action bez zmian.** Błędna polityka to tam nadal wynik `failure` bez pliku SARIF, jak w udokumentowanym zachowaniu.
- **`schemaVersion` zostaje 1.** Nowa wartość `policy` i nowa reguła nie psują dotychczasowych odbiorców, a wcześniej w tym przypadku nie było żadnego dokumentu. CLAUDE.md doprecyzowuje zasadę: nowa wersja schematu tylko przy zmianie niezgodnej wstecz.
- **Poza zakresem.** `check --json` przy błędnej polityce nadal pisze tekst na stderr.

## D-070 · `check --json` przy błędnej polityce (2026-10-30)

- **Problem.** `check --json` przy błędnym albo nieczytelnym `depcurfew.json` pisał tekst na stderr i nic na stdout. Uwaga o braku polityki też szła na stderr. To było ostatnie odstępstwo od zasad komunikatów w CLAUDE.md (D-069, „Poza zakresem”).
- **Decyzja.** Dokument ma ten sam kształt co dotąd (`schemaVersion`, `policy`, `packages`) i dwa nowe pola, `notices` i `errors`; stderr zostaje pusty.
  - Przy polityce, której nie da się użyć, `packages` jest puste, bo bez polityki nic nie jest sprawdzane, a kod wyjścia to 1.
  - `errors` ma kształt błędu z `apply --json`: `code` (`policy-invalid`, `policy-unreadable`), `level`, `location`, `message`, `fix` i `issues`.
  - Uwaga o braku `depcurfew.json` trafia w trybie JSON do `notices` zamiast na stderr. Wtedy `apply`, `doctor` i `check` mają w trybie JSON pusty stderr.
- **Jedno źródło `fix`.** `policyErrorFix` w `src/apply/index.ts` daje tę samą poprawkę dla reguły `invalid-policy` w `doctor` i dla JSON z `apply` i `check`; `apply --json` ma teraz `fix` także dla `policy-invalid`.
- **Bez zmian.** Tryb tekstowy `check` (błąd na stderr, kod 1) i hook Claude Code, który przy błędnej polityce już wcześniej odpowiadał decyzją `ask` w JSON.
- **`schemaVersion` zostaje 1.** Nowe pola nie psują dotychczasowych odbiorców (zasada z CLAUDE.md).

## D-071 · Python w `check` i w hooku Claude Code (2026-10-30)

- **Problem.** `check` i hook sprawdzały tylko paczki npm. Polecenia `pip install`, `uv add`, `uvx`, `poetry add` i `pipx` przechodziły bez sprawdzenia, choć faza 10 obsługuje Pythona w `apply` i `doctor`.
- **Decyzja: paczki Pythona mają prefiks `pypi:`,** tak jak nazwy w polityce (D-065). `check pypi:<wymaganie>` przyjmuje wymaganie jak pip (PEP 508: nazwa, extras, specyfikatory, znaczniki środowiska są pomijane) albo `nazwa@wersja`, `nazwa@^1.2` i `nazwa@latest` jak `uvx` i `poetry add`. Ograniczenia Poetry (`^`, `~`, `1.*`) są przeliczane na PEP 440 według tabel z dokumentacji Poetry 2.5.1.
- **Źródło danych: Index API PyPI (JSON, PEP 691/700/792),** a nie `/pypi/<nazwa>/json`, którego klucz `releases` dokumentacja PyPI oznacza jako przestarzały. Strona projektu nie mówi, do której wersji należy plik, więc wersja pochodzi z nazwy pliku (wheel: `{nazwa}-{wersja}-…`, sdist: `{nazwa}-{wersja}.<archiwum>`, ze starymi nazwami z myślnikami). Jaja i instalatory Windows są pomijane, bo pip i uv ich z indeksu nie instalują.
- **Co jest sprawdzane:**
  - brak projektu (`not-found`) i podobne nazwy (`similar-name`): 5000 najpopularniejszych projektów PyPI z miesięcznego rankingu opartego na publicznych statystykach PyPI w BigQuery, porównanie po normalizacji PEP 503, więc `python_dateutil` to ta sama paczka co `python-dateutil`;
  - wybór wersji jak w pip (PEP 440): najnowsza pasująca, wydania przedpremierowe tylko na żądanie albo gdy nic innego nie pasuje, wersje wycofane (yanked) tylko przy przypięciu `==`/`===` (wtedy ostrzeżenie `yanked`, PEP 592);
  - wiek: według najnowszego pliku wersji, bo do wydania można później dodać pliki, a instalator może wybrać każdy z nich (zaokrąglenie w stronę dłuższego opóźnienia). Brak czasu przesłania to `unverified`;
  - brak wheel (same sdisty): `install-scripts`, bo instalacja buduje paczkę ze źródeł i uruchamia jej kod budowania (D-065);
  - status projektu (PEP 792): `quarantined` to błąd i odmowa w hooku, `archived` i `deprecated` to ostrzeżenia;
  - git, URL i ścieżki według reguł pip, wspólnych z `doctor` (`requirementSource` w `src/doctor/python-lockfiles.ts`): tylko sekcja `sources`; `.` (sam projekt) to ostrzeżenie, inne systemy kontroli wersji to `unverified`.
- **Nowe kody:** `yanked`, `archived`, `quarantined`. `schemaVersion` zostaje 1, bo nowe wartości nie psują odbiorców; nazwa paczki w raporcie ma prefiks `pypi:`.
- **Hook:** czyta `pip install` (też `pip3`, `pip3.12`, `python -m pip`, `py -m pip`), `uv add`, `uv pip install`, `uv tool install`, `uvx`, `uv tool run`, `uv run --with`, `poetry add`, `pipx install` i `pipx run`.
  - Polecenia Pythona są dopasowywane słowo po słowie. Wspólna lista podpoleceń zostaje tylko dla npm, bo `poetry install` czy `uv sync` niczego nie dodają.
  - Opcje są czytane tak jak przez dane narzędzie: skróty długich opcji w pip i pipx (optparse, argparse), grupy krótkich opcji i wartość w tym samym słowie (`-Uihttps://…`) oraz opcje różne w poszczególnych poleceniach (`-e` w `uv pip install` ma wartość, w `uv tool install` to flaga). Bez tego hook dałoby się obejść.
  - Opcja albo zmienna, która wskazuje inny indeks (`--index-url`, `--extra-index-url`, `--find-links`, `--index`, `--source`, `--pip-args`, `PIP_INDEX_URL`, `UV_INDEX`, `PIP_CONFIG_FILE` i inne), daje „ask”. Sam PyPI jest dozwolony.
  - `uvx python…`, `uvx pypy@3.10` uruchamiają interpreter, nie paczkę. Skrypt pobierany z URL (`uv run https://…`, `pipx run https://….py`) daje „ask”.
- **Poza zakresem:** paczki z plików wymagań (`pip install -r`) i z plików projektu (`uv sync`, `poetry install`) nie są sprawdzane, tak jak `npm install` bez nazw; lockfile'e sprawdza `doctor`. Indeks ustawiony w konfiguracji projektu nie jest czytany; inny indeks podaje się przez `--index`.
- **Fakty** są w bazie wiedzy ze źródłami przypiętymi do wersji: polecenia i opcje w `pip.ts` (z pipx), `uv.ts` i `poetry.ts`, Index API, statusy projektów, rozszerzenia sdistów i interpreter w `environment.ts`. Nowe oficjalne źródła: `github.com/pypi/` (dokumentacja PyPI) i `github.com/python/` (dokumentacja CPython).

## D-072 · PDM i Pipenv; Hatch przez uv (2026-10-30)

- **Problem.** Projekty Pythona z PDM, Pipenv albo Hatch nie były wykrywane ani konfigurowane, a ich lockfile'e nie były sprawdzane.
- **PDM (2.29.5): pełna obsługa.**
  - `apply` pisze jeden zarządzany blok w `[tool.pdm.resolution]` pliku pyproject.toml: opóźnienie w formacie PDM (`36h`, `2d`, `1w`, od 2.26.9), wyjątki jako tabelę inline z `false` (od 2.29.1), zakaz budowania `":all:"` i listę paczek zawsze budowanych ze źródeł (od 2.15.0, D-065).
  - `doctor` czyta `pdm.lock` (źródła i paczki z indeksu bez wheel), zgłasza stałą datę zamiast opóźnienia i tryb uv (`use_uv` w pdm.toml), w którym PDM instaluje przez `uv sync` bez zakazu budowania.
  - Hook czyta `pdm add` (w tym `-e`, skróty opcji argparse, `--venv`, które zabiera następne słowo), a `PDM_PYPI_URL`, `-c`/`--config` i `PDM_CONFIG_FILE` dają „ask”.
- **Pipenv (2026.10.4): tylko opóźnienie,** bo Pipfile nie ma innych ustawień.
  - `apply` pisze opóźnienie w pełnych dniach, zaokrąglonych w górę (`<int>d`, od 2026.6.2), w bloku w `[pipenv]` Pipfile. Ostrzega, że wyjątków nie ma (`exclude-unsupported`) i że zakaz budowania wymaga `PIP_ONLY_BINARY=:all:` w środowisku (`build-switch-environment-only`).
  - `doctor` czyta `Pipfile.lock`: źródła git, URL i ścieżki. Dla paczek z indeksu hashe nie odróżniają wheel od sdista, więc budowanie jest nieznane. Zgłasza `resolver_backend = "pure-python"` (także stary klucz `resolver`), przy którym Pipenv blokuje wersje bez opóźnienia; to zachowanie nieudokumentowane, sprawdzone na 2026.10.4.
  - Hook czyta `pipenv install <paczka>` (bez paczek to instalacja z Pipfile); `-i`, `--pypi-mirror`, `PIPENV_PYPI_MIRROR`, `--extra-pip-args` i `PIPENV_DOTENV_LOCATION` dają „ask”.
- **Wersji nie da się przypiąć.** Ani PDM, ani Pipenv nie mają ustawienia wersji w projekcie, więc `apply` konfiguruje dla najnowszej znanej wersji, a `version-not-pinned` mówi to wprost zamiast odsyłać do nieistniejącego miejsca.
- **Hatch (1.18.2): bez generatora.** Hatch nie ma własnych ustawień opóźnienia, budowania ani źródeł; jego środowiska instalują przez uv albo pip. Projekt Hatch z instalatorem uv obsługuje istniejący generator uv (`"uv"` w `targets`, bo uv czyta `[tool.uv]` także pod Hatchem), a środowiska z pip — zmienne środowiskowe pip. README to opisuje; osobne wykrywanie Hatch nie dawałoby nic do skonfigurowania.
- **Boty.** Dependabot `pip` obejmuje Pipenv; PDM nie jest obsługiwany (dependabot-core pomija pyproject.toml przy pdm.lock). Renovate: `pep621` dla PDM, `pipenv` dla Pipenv.
- **Nowe kody `apply`:** `exclude-unsupported`, `build-switch-environment-only`. Nowe narzędzia w `targets` (schema.json): `pdm`, `pipenv`.

## D-073 · Poprawki z pełnego testu paczki (2026-10-30)

Pełny test paczki z tarballa (`npm pack`) na projektach testowych npm, pnpm, Yarn, Bun, Deno, uv, Poetry, pip, PDM, Pipenv i Hatch, z botami, GitHub Action i biblioteką, znalazł cztery rzeczy do poprawy:

- **Podwójny znacznik w YAML.** Po ręcznej zmianie `default-days` w dependabot.yml `apply` dopisywał drugi komentarz `# managed by depcurfew` wewnątrz bloku `cooldown`, który już go miał. Klucz w mapie oznaczonej znacznikiem nie dostaje teraz własnego, ani przy podmianie wartości, ani przy dopisaniu nowego klucza.
- **Wskazówki hooka.** Polecenie wskazujące inny indeks, pobierany skrypt (`uv run https://…`) i powłoka czytająca z potoku dostawały ogólną wskazówkę „wypisz nazwy paczek”. Każdy przypadek ma teraz własną (`unreadableFix` w `src/check/command.ts`, z tych samych stałych, z których powstaje powód).
- **Zepsuty pyproject.toml.** `explain` zgłaszał obok `invalid-file` mylące `python-tool-unknown` („brak tabeli”), a `apply` mówił tylko, że nie ma czego konfigurować. Teraz zostaje samo `invalid-file`, a `apply` ostrzega nowym kodem `file-unreadable` z położeniem i poprawką.
- **Hatch.** Ostrzeżenie `python-tool-unknown` w projekcie z `[tool.hatch]` albo `hatch.toml` podpowiada dodanie `"uv"` do `targets`, zgodnie z D-072.

Bez zmian, bo to zamierzone: puste `FORCE_COLOR=` włącza kolory, a `FORCE_COLOR` wygrywa z `NO_COLOR`, tak jak w Node i supports-color (test w `tests/color.test.ts`). Krok Node akcji kończy się kodem 0 przy błędach, a zadanie przerywa następny krok `action.yml` (`fail-on-error`).

## D-074 · Edytory plików i zapis `apply` po przeglądzie przed 1.0.0 (2026-10-30)

Przegląd przed 1.0.0 znalazł w edytorach i w zapisie `apply` błędy, przez które plik użytkownika mógł się zepsuć albo zmienić tylko w części. Wszystkie są odtworzone w testach i fiksturach (`dependabot-comments`, `pnpm-workspace-comments`, `yarn-berry-comments`, `uv-pdm-pyproject`, `uv-pdm-legacy-blocks`, `npmrc-restore`, `pip-restore`, `bun-restore`).

- **YAML: komentarz na końcu mapy albo listy.** Biblioteka `yaml` wlicza komentarze po kolekcji i wcięcie następnej linii do zakresu węzła, więc wstawienie klucza i podmiana listy kończyły się w środku wcięcia: następny wpis `updates` lądował w kolumnie 0, a `apply` kończył się kodem 0. Teraz edycja kończy się na ostatniej linii treści (z komentarzem w tej samej linii).
  - Komentarze po niej zostają na miejscu. Nowy klucz trafia przed nimi, z wyjątkiem komentarzy wciętych głębiej niż klucze mapy, bo należą do ostatniej wartości (np. zakomentowany element listy `ignore`).
  - Przy podmianie listy zostają komentarz w linii klucza, komentarze przed pierwszym elementem i komentarze po ostatnim.
- **Edycja YAML i JSON jest sprawdzana.** Plik musi się parsować przed edycją i po niej, a wynik musi zawierać dokładnie stare dane z jedną zmienioną wartością (`src/apply/expected.ts`). Inaczej to `cannot-edit` z położeniem i nic nie jest zapisane. Tak samo jak w TOML (D-067).
  - JSON jest parsowany ściśle jako JSONC (JSON z komentarzami i przecinkami na końcu, które edytor zachowuje), z linią i kolumną błędu. Wcześniej `deno.json` bez przecinka był edytowany i zapisywany z kodem 0, wbrew D-028.
  - Pliki JSON5 (`renovate.json5`, `.renovaterc`, `package.json5`) nadal nie są edytowane: Renovate dostaje fragment do wklejenia, a pnpm ich nie dotyka.
- **uv i PDM w jednym pyproject.toml.** Oba bloki miały ten sam znacznik, a usuwanie bloku brało pierwszy w pliku, więc blok uv znikał. W pyproject.toml znacznik nazywa teraz tabelę, jak w Poetry (`[tool.uv]`, `[tool.pdm.resolution]`); w `uv.toml` zostaje bez nazwy. Blok bez nazwy zapisany przez wcześniejszą wersję w tej samej tabeli jest rozpoznawany i zamieniany, bez duplikatu.
- **Zapis wszystkich plików albo żadnego.** `writeChanges` najpierw zapisuje wszystkie pliki tymczasowe, potem robi wszystkie `rename`.
  - Przy błędzie usuwa pliki tymczasowe i utworzone katalogi, a podmienionym plikom przywraca starą treść z pamięci.
  - Błąd zapisu ma nowy kod `cannot-write` (plik, powód prostymi słowami, poprawka), w tekście i w `--json`, z kodem wyjścia 1. Biblioteka rzuca `ApplyWriteError` z raportem planu.
  - Błąd odczytu (np. `EACCES`) to `cannot-edit` z powodem zamiast śladu stosu.
- **Plik tymczasowy od razu z trybem pliku.** Powstaje z trybem pliku, który zastępuje (`wx` i `mode`, umask może go tylko zawęzić), więc `.npmrc` z tokenem nie jest ani przez chwilę czytelny dla innych.
- **Zakomentowane ustawienia wracają (zmiana D-029).** Linia z prefiksem `superseded by the managed block` albo `turned off`, której klucza polityka już nie zarządza, wraca dosłownie (w TOML z każdą linią wartości). Dotyczy `.npmrc`, plików TOML i requirements.txt. Wcześniej po usunięciu sekcji z polityki zostawał sam komentarz i narzędzie traciło ustawienie użytkownika.
  - Generatory edytują plik także wtedy, gdy są w nim tylko takie linie.
  - W TOML wracają tylko linie z tabeli danego generatora, więc uv nie przywraca linii, które zakomentował PDM.
- **Drobne.**
  - `removeBlock` zdejmuje wszystkie kopie zdublowanego bloku.
  - Plik z końcami CRLF i LF zachowuje koniec każdej niezmienionej linii; zmieniona linia dostaje koniec linii, którą zastępuje, a nowa koniec poprzedniej.
  - Plik spoza UTF-8 to `cannot-edit` zamiast zamiany bajtów na U+FFFD; BOM zostaje.

## D-075 · `init` i `apply`: dłuższe opóźnienie zostaje, wpisy Renovate, pliki ignorowane przez git, bez nowych manifestów (2026-10-30)

Przegląd przed 1.0.0 znalazł pięć błędów w semantyce `init` i `apply`; każdy jest odtworzony na projekcie testowym i na fiksturze w stylu prawdziwego repozytorium.

- **Dłuższe opóźnienie nie znika po cichu.** `init` z domyślnym `3d` i `apply` zastępowały dłuższe opóźnienie użytkownika bez słowa (express: `.npmrc` 7 → 3 dni, renovatebot/github-action: pnpm 10080 → 4320 minut, python-poetry/poetry: Dependabot 7 → 3 dni), a `doctor` potem nic nie zgłaszał.
  - `src/apply/delays.ts` czyta skonfigurowane opóźnienia czytnikami `doctor` (`readSetting`, `readPythonSetting`, `yamlSetting`, `jsonSetting`, `delayMinutes`) z pliku, który narzędzie czyta pierwszy, w katalogu głównym: npm, pnpm (także `minimum-release-age` w `.npmrc` dla pnpm przed 11, nowy fakt `npmrcCooldownKey`), Yarn, Bun, Deno (także postać obiektowa), uv i PDM (tylko czas trwania, nie data), Poetry, Pipenv, Renovate (`minimumReleaseAge` w JSON i JSONC) oraz każdy wpis Dependabota (`default-days`).
  - `init` zapisuje najdłuższe z nich jako `cooldown.minimum`, gdy jest dłuższe od domyślnego, zaokrąglone w górę do pełnych minut (dni, godziny albo minuty, co wychodzi dokładnie), i mówi, skąd je wziął: ustawienie, wartość, plik i linia.
  - `apply` porównuje opóźnienia przed planem i po nim (pliki czytane tak, jak je zostawi) i ostrzega `cooldown-shortened`: plik, linia, stara i nowa wartość oraz `cooldown.minimum`, które zachowa dłuższe opóźnienie. Wartości w bloku i pod znacznikiem depcurfew są pomijane, bo to celowa zmiana polityki. JSON nie ma znaczników, więc wartość w `renovate.json` albo `deno.json` liczy się zawsze jako ustawiona ręcznie.
  - Presety Renovate nie są czytane, bo źródła nie mówią, czy jawne `minimumReleaseAge` przesłania regułę presetu. `ApplyWarning.location` dostało opcjonalne `line` (zmiana zgodna wstecz).
- **pnpm przed 10 i `installScripts.default: "deny"`.** pnpm przed 10.0.0 uruchamia wszystkie skrypty i nie ma listy dozwolonych, a `apply` milczało. Teraz ostrzega `scripts-not-enforceable` jak w npm, z poprawką „wymagaj pnpm 10.0.0”; wartość domyślną czyta wspólna funkcja `scriptsDefault`. Pozostałe generatory tej luki nie mają: Yarn zawsze dostaje przełącznik skryptów, Bun i Deno domyślnie blokują skrypty, a generatory Pythona przy zbyt starej wersji ostrzegają `version-too-old`.
- **Wpisy Renovate w wyjątkach pnpm zostają (decyzja właściciela).** Kod Renovate 44.198.2 (`lib/modules/manager/npm/artifacts.ts`, `updatePnpmWorkspace`, z testami) przy aktualizacji bezpieczeństwa projektu pnpm, którego `pnpm-workspace.yaml` ustawia `minimumReleaseAge`, dopisuje do `minimumReleaseAgeExclude` wpis `<nazwa>@<wersja>` z komentarzem `# Renovate security update: <nazwa>@<wersja>` w linii nad nim, a kolejne wersje łączy ` || `. npm, Yarn, Bun i Deno takiego kodu nie mają. Fakt `pnpmSecurityExclusions` w bazie Renovate (niepewny, bo z kodu).
  - `apply` rozpoznaje tylko ten format (nazwa w komentarzu równa nazwie we wpisie, same dokładne wersje), zostawia takie wpisy razem z komentarzem i zmienia tylko wpisy polityki; lista z tymi samymi elementami w innej kolejności się nie zmienia. Wpisy, które Renovate dopisze później, też zostają.
  - `config-drift` porównuje pliki z planem `apply`, więc reguły `doctor` nie trzeba było zmieniać.
- **Pliki ignorowane przez git.** Nowe ostrzeżenie `file-ignored-by-git`, gdy `apply` zapisuje plik pasujący do `.gitignore` (w katalogu głównym i w katalogach po drodze) albo `.git/info/exclude`, z plikiem i linią reguły.
  - Własny dopasowywacz bez wyrażeń regularnych, bo wzorce pochodzą z repozytorium i `*a*a*a…` nie może zawiesić `doctor` w CI: komentarze, `!`, kotwiczenie przez `/`, `/` na końcu, `*`, `?`, `**`, `\`, a pliku w wykluczonym katalogu nie da się włączyć z powrotem. Klasy znaków (`[...]`) są pomijane; gdy pominięty wzorzec jest negacją, ostrzeżenia nie ma, żeby nigdy nie było fałszywe.
  - Plików śledzonych `.gitignore` nie dotyczy, więc depcurfew czyta `.git/index` (wersje 2–4, SHA-1 i SHA-256; tryb split index daje „nie wiadomo”). Gdy indeksu nie ma albo nie da się go przeczytać, komunikat o istniejącym pliku dodaje „unless git already tracks it”. `core.excludesFile` i `.gitignore` powyżej katalogu, w którym działa `apply`, nie są czytane.
  - Fakt `environment.git.ignore` ze źródłem w `git/git` v2.56.0; `github.com/git/` doszło do oficjalnych lokalizacji faktów o środowisku.
- **Bez nowych manifestów i bez narzędzi widzianych tylko w CI.**
  - `apply` nie tworzy manifestu projektu, czyli pliku z `project.manifests` któregokolwiek narzędzia (`package.json`, `deno.json`, `pyproject.toml`, `Pipfile`, `requirements.txt`), a tylko pliki konfiguracyjne menedżerów (`.npmrc`, `bunfig.toml`, `uv.toml`, `poetry.toml` …). Edycja brakującego manifestu jest pomijana i zgłaszana jako `manifest-missing` z nazwami niezapisanych ustawień. `deno.json` też jest manifestem, więc Deno bez niego (np. tylko z `deno.lock`) dostaje ostrzeżenie zamiast nowego pliku.
  - Przy `targets: "auto"` menedżer wykryty wyłącznie z kroku CI, bez żadnego swojego manifestu w repozytorium, nie jest konfigurowany: niczego z repozytorium nie instaluje, a jego konfiguracja oznaczałaby nowe pliki (denoland/std dostawał `package.json` i `bunfig.toml`, bo Bun był tylko w `oven-sh/setup-bun`). Ostrzeżenie `tool-only-in-ci` mówi, jak go włączyć (`targets`). Z manifestem (np. `package.json` bez lockfile'a i pnpm z `pnpm/action-setup`) narzędzie jest konfigurowane jak dotąd, a `explain` pokazuje te same cele co `apply`.
- **Fikstury:** `npm-longer-cooldown`, `pnpm-renovate-security`, `poetry-gitignored`, `deno-ci-bun` i `yarn-longer-cooldown`; `uv-workspace` dostał oczekiwane `cooldown-shortened` (`exclude-newer = "1 week"`). Testy jednostkowe są w `tests/apply/delays.test.ts`, `tests/apply/review-apply.test.ts` i `tests/init.test.ts`.

## D-076 · Luki w regułach `doctor` przed 1.0.0 (2026-10-30)

Przegląd reguł `doctor` znalazł konfiguracje, które po cichu nie działały, a `doctor` je przepuszczał, oraz dwa wyjątki zamiast znalezisk. Każdy przypadek ma fiksturę albo test i został odtworzony przed i po poprawce.

- **`.npmrc` czytany jak przez npm.** npm czyta plik pakietem `ini` (7.0.0 w npm 12.2.1, ta sama `lib/ini.js` w 6.0.0 z npm 11.10–11.21). `iniEntries` odtwarza go: komentarz w linii po niezacytowanym `#` albo `;` (`ignore-scripts=true # …` daje `true`), cudzysłowy, ucieczki, klucz bez `=` to `true`. Klucze pod nagłówkiem `[sekcja]` należą do sekcji, a npm bierze ustawienia tylko z poziomu głównego, więc `iniEntries` ich nie zwraca (`iniLines` tak, z polem `section`). Fakt `npmrcFormat` (źródło: `npm/ini` v7.0.0). Tym samym czytnikiem `doctor` czyta `.npmrc` pnpm 10; korzysta z niego też `check` (rejestr).
- **Blok w `.npmrc` przed pierwszą sekcją.** `apply` dopisywał blok na końcu pliku, więc w pliku kończącym się sekcją nie działał. Teraz wstawia go przed pierwszy nagłówek (nad komentarze, które go poprzedzają), przenosi tam blok dopisany wcześniej w sekcji i nie komentuje kluczy w sekcjach, bo to inne ustawienia. `npmrc-overrides-policy` zgłasza klucze bezpieczeństwa pod nagłówkiem sekcji: blok zarządzany i klucz bez odpowiednika na poziomie głównym jako `error`, duplikat jako `warning`.
- **`before=` w `.npmrc`** (fakt `beforeInteraction` w postaci strukturalnej, źródło: `definitions.js` npm). Od npm 11.15 `before` wygrywa z `min-release-age` z tego samego pliku: data w przyszłości albo świeższa niż opóźnienie to `error`, starsza to `warning` (zamrożenie blokuje też poprawki bezpieczeństwa), jak `fixedDate` dla uv i PDM. npm 11.10–11.14 przy obu ustawieniach kończy się błędem (`exclusive`), co też jest `error`. Reguła działa, gdy polityka ma `cooldown` albo `.npmrc` ustawia `min-release-age`. Zmiennych `npm_config_before` z workflow `doctor` nie czyta, bo nie czyta żadnych zmiennych środowiskowych z CI.
- **Renovate: reguły `packageRules` i presety** (`src/doctor/renovate.ts`, fakty `packageRuleMatching`, `packageRulesOrder`, `delayedUpdateTypes`, `internalPresets`, źródła przypięte do 44.198.2).
  - Reguła obejmuje wszystkie paczki rejestru, gdy jej jedyne matchery to `matchPackageNames`/`matchDepNames` z samymi wzorcami negatywnymi albo wzorcem wszystkiego, `matchDatasources` pasujące do źródła rejestru (jak `matchRegexOrGlobList`) i `matchUpdateTypes` z którymś z `major`, `minor`, `patch`. Każdy inny matcher (`matchManagers`, `matchDepTypes`, `matchFileNames`…) to wyjątek dla części paczek i się nie liczy, żeby nie zgłaszać fałszywie; glob z klamrami lub klasami też.
  - `broad-exclusion` zgłasza taką regułę, gdy wyłącza opóźnienie (`null` albo zerowy czas), dla rejestrów wykrytych menedżerów.
  - `bot-cooldown-mismatch` liczy opóźnienie bota jak Renovate: poziom główny, potem reguły presetów, potem reguły repozytorium; liczy się najkrótsze z typów aktualizacji. `config:best-practices` ustawia więc 3 dni dla npm także przy krótszym poziomie głównym. Reguła repozytorium, która opóźnienie wyłącza, jest zgłaszana tylko przez `broad-exclusion`, a skracająca przez `bot-cooldown-mismatch` z poprawką wskazującą tę regułę.
  - Preset spoza wbudowanych (np. `github>…`, `local>…`), którego `doctor` nie umie odczytać bez sieci, daje znalezisko `note` z plikiem, linią i poprawką zamiast błędu „brak opóźnienia”, chyba że repozytorium samo ustawia opóźnienie. Wybrałem `note`, a nie samą uwagę (`notices`), bo ma położenie i `fix`.
- **pnpm 10: opóźnienie z `.npmrc`.** `managerDelay` czyta `minimum-release-age` z głównego `.npmrc` dla pnpm przed 11, gdy `pnpm-workspace.yaml` go nie ustawia (fakty `npmrcPrecedence` i `ignoredSince`), tak jak już robiła reguła `npmrc-overrides-policy`.
- **Dependabot `cooldown.include`** (fakt `cooldownInclude`). Samouczek GitHuba o cooldown mówi, że lista stosuje opóźnienie do wymienionych zależności, a dla wszystkich trzeba pominąć `include` albo dać `"*"`. W dependabot-core zależność spoza listy pomija cooldown w całości, także domyślne 3 dni (`included?`, `skip_cooldown?`). `bot-cooldown-mismatch` zgłasza wtedy `error` dla pozostałych zależności z poprawką „usuń `include`, wyjątki wpisz w `exclude`”. `apply` nie usuwa `include`, bo nim nie zarządza.
- **Python.**
  - `Pipfile.lock` z `"path": "."` (`pipenv install -e .`) i `pylock.toml` z `directory = { path = "." }` albo z katalogiem członka workspace'u to część workspace'u, tak jak `-e .` w requirements i `editable = "."` w `uv.lock`. Znikają fałszywe błędy `lockfile-install-scripts` i `lockfile-forbidden-source`.
  - `pylock.toml` należy do narzędzia z `created-by` (pole wymagane przez PEP 751), jeśli depcurfew je obsługuje: fakty `pylockCreatedBy` (uv, pdm, pipenv, `poetry-plugin-export`, pip), porównanie po normalizacji PEP 503. Wykrywanie czyta klucz z początku pliku, przed pierwszą tabelą; `doctor` czyta wtedy plik jako lockfile tego narzędzia. Bez znanego `created-by` plik zostaje przy pip, jak dotąd.
- **Błędy odczytu bez śladu stosu.** `Repository.readText` i `readHead` łapią błąd odczytu (np. `EACCES`) i zgłaszają ostrzeżenie `unreadable-file`, które `unreadable-config` pokazuje jako `error` z kodem błędu, bez ścieżki bezwzględnej. Liczba w TOML większa niż `Number.MAX_SAFE_INTEGER` (BigInt) to wartość, której `doctor` nie umie odczytać: uwaga zamiast wyjątku w `JSON.stringify`.
- **Poza zakresem:** `matchManagers` i `matchCategories` Renovate nie są oceniane (brak faktów o identyfikatorach menedżerów Renovate dla JavaScriptu); własny czytnik `.npmrc` pnpm (config-chain) nie był sprawdzany, `doctor` stosuje do niego reguły pakietu `ini`.

## D-077 · Obejścia `check` i hooka: skróty opcji, rejestr z `.npmrc`, wybierana wersja (2026-10-30)

Przegląd i pentest przed 1.0.0 znalazły polecenia, przy których hook nie podejmował decyzji, choć powinien pytać albo odmawiać, oraz sprawdzanie innej wersji, niż zainstaluje menedżer.

- **Opcje npm i pnpm czytane jak nopt.** Oba parsują wiersz poleceń przez nopt (pnpm przez fork `@pnpm/nopt`): dowolna liczba myślników (`-registry`, `---reg`), skróty (`--reg` to `--registry`), grupy jednoliterowych skrótów (`-gD`), `--no-<nazwa>` bez wartości i jednoznaczny prefiks nazwy (`--regis`, `--userc`). npm 10 rozwija prefiksy po cichu, 11 z ostrzeżeniem, 12 je odrzuca (`EUNKNOWNCONFIG`), więc liczymy je jak w npm 11. pnpm ma też `--config.<klucz>=…`, które ustawia dowolne ustawienie, oraz `--npmrc-auth-file`/`--userconfig` jako plik `.npmrc` użytkownika.
  - Fakty: `flagOptions` i `parsing` npm (definitions.js i definitions/index.js 12.2.1, zgodne z 11.21.1), `parsing` i poszerzone `registryOverrides` pnpm (12.16.1).
  - Prefiks rozwijamy do dowolnej opcji tylko wtedy, gdy narzędzie ma w bazie pełną listę flag (npm, pip, pipx, PDM, Pipenv). Dla pnpm bez tej listy prefiks rozwija się wyłącznie do opcji rejestru albo pliku konfiguracji: błędne rozwinięcie flagi (np. `--lockfile` do `--lockfile-dir`) zjadłoby nazwę paczki. pnpm i tak kończy się błędem przy opcji, której nie zna.
- **Rejestr z `.npmrc` repozytorium.** Nie zamieniamy każdego innego rejestru na `ask`, bo npm i tak pobierze z niego paczki, a firmowe rejestry są normalne. Zamiast tego:
  - przekierowanie (`redirect: 'manual'`) jest śledzone tylko w obrębie tego samego originu, najwyżej 5 razy; przekierowanie na inny host daje `unverified` (w hooku `ask`), bo tamten host mógłby zgłosić wymyśloną nazwę jako starą, czystą paczkę. To samo dla indeksu PyPI z `--index`;
  - gdy rejestr nie jest publiczny, `check` (uwaga w `notices` albo `note:` na stderr) i powód hooka mówią, który rejestr zapytano i skąd pochodzi (`registry= in .npmrc, line N`, `--registry`);
  - rejestr albo indeks `http://` to nowe ostrzeżenie `insecure-registry` (podatne na MITM), bez zmiany decyzji;
  - adres link-local podany dosłownym IP (169.254.0.0/16, fe80::/10, także w postaci IPv4 w IPv6) nie jest w ogóle pytany: wynik `unverified`, czyli `ask`. Tam odpowiadają usługi metadanych chmury i nie ma tam rejestrów, więc to nie psuje firmowych instalacji. Loopback i sieci prywatne pytamy jak dotąd: lokalny Verdaccio i firmowe rejestry są częste, a złośliwa odpowiedź z loopbacku wymaga programu już działającego na maszynie. Nazw nie rozwiązujemy (np. `metadata.google.internal`), bo depcurfew nie robi własnych zapytań DNS.
- **Wersja, którą wybierze menedżer.**
  - npm: dist-tag z `--tag`, `npm_config_tag` (w poleceniu, bez względu na wielkość liter) albo `tag=` w `.npmrc` projektu lub użytkownika trafia do wyboru wersji (fakt `versionSelection`). Wybór wersji odwzorowuje npm-pick-manifest 12.0.0: nazwa bez wersji to `*`, dla `*` bierzemy wersję preferowanego tagu nawet przedpremierową (`npm i crossenv@*` daje `0.0.2-security`), dla innego zakresu tylko gdy go spełnia; wersję wycofaną pomijamy. Raport ma pole `tag`, a powód hooka etykietę `(tag next)`.
  - Python: fakty `selection` (pip, pipx, uv, PDM, Pipenv, Poetry) opisują opcje i zmienne przedpremierowe (`--pre`, `--all-releases`/`--only-final`, `--prerelease allow|disallow`, `--prerelease-package`, `PIP_PRE`, `UV_PRERELEASE`, PDM `--pre`/`--stable`, Poetry `--allow-prereleases`) oraz budowanie ze źródeł (`--no-binary`/`--only-binary` z `:all:`/`:none:`, uv `--no-binary`/`--binary`/`--no-binary-package`, `PIP_NO_BINARY`, `UV_NO_BINARY`, `PDM_NO_BINARY`, `POETRY_INSTALLER_NO_BINARY`). Zmienne liczą się przed opcjami, późniejsze wygrywa, a paczka nazwana wprost wygrywa z `:all:` (jak `FormatControl` w pip). Budowanie wymuszone przez polecenie przy paczce ze sdistem to `install-scripts` (D-065).
  - Wartość rozwijana przez powłokę (`--tag $T`, `PIP_NO_BINARY=$X`) daje `ask`.
- **Skaner.** Menedżer z wersją uruchomiony przez runner (`npx npm@11`, `uvx pip@25`, `pipx run pip==25.0`, `strace pip3.12`); wrappery `su`/`runuser`/`script` (opcje w dowolnym miejscu i grupowane, jak getopt), `flock … -c`; powłoki `ash`, `mksh`, `yash`, `posh`, `csh`, `tcsh` i PowerShell (`-Command`, `-File`, `-EncodedCommand` daje `ask`); `source`/`.` ze stdin. Jako odpowiedniki `curl | sh` dają `ask`: `bash <(curl …)`, `source <(…)`, interpreter czytający program z potoku (`curl … | python3|node|ruby|perl|php`) i `iex` (`irm … | iex`, `iex (irm …)`). `echo` i `printf` niczego nie uruchamiają, a `find -exec … ;` kończy polecenie na `;`/`+` i wstawia nazwy plików w `{}`. Listy wrapperów, powłok i interpreterów zostają w kodzie, jak dotąd.
- **Limit.** Hook sprawdza najwyżej 50 specyfikacji jednego polecenia; reszta daje `ask` z powodem, zamiast tysięcy zapytań do rejestru.
- **Nazwy `pypi:` w polityce** są porównywane po normalizacji PEP 503 także w `check` i hooku (`pypi:PyCrypto`, `pypi:Python_DateUtil`), jak w `doctor`.
- **Deno.** `deno x` (2.9.8: `X_SUBCOMMAND`) i aliasy `dx`, `denox`, `dnx` są czytane jak `npx`, z `-p`/`--package` i opcjami z wartością z `defs.rs`; `npm:<paczka>/<binarka>` sprawdza paczkę.
- **Poza zakresem.** `--prefix`/`-C`, które każe npm czytać `.npmrc` innego katalogu (D-055: agent może też zmienić `.npmrc`), zmienne środowiska samego procesu hooka (czytamy tylko te z polecenia), `deno create` oraz skróty opcji Yarna i Buna.

## D-078 · Bezpieczne wyjście tekstowe, błędy wejścia, polityka z katalogu nadrzędnego i porządki prawne (2026-10-30)

Przegląd przed wydaniem 1.0.0 (pentest i przegląd CLI) znalazł:

- **Sekwencje sterujące terminala (bezpieczeństwo).** Nazwy paczek z lockfile'i, nazwy plików, klucze i wartości konfiguracji, pole `deprecated` i skrypty z rejestru trafiały dosłownie do tekstu, więc spreparowane repozytorium albo paczka mogły podrobić link (OSC 8), zmienić tytuł okna albo wyczyścić linię.
  - Jedna funkcja `printable` (`src/printable.ts`) zamienia znaki C0 poza tabulatorem, DEL i C1 na `\xHH`. Nowe linie z niezaufanych treści też, żeby wartość nie zaczęła własnej linii (np. fałszywego `fix:`); fragmenty do ręcznego dodania w `apply` zachowują swoje nowe linie.
  - Działa przed dodaniem kolorów w tekście `doctor`, `check`, `apply` (ostrzeżenia, błędy, nazwy plików), `explain`, w błędach wejścia i w Action: log, adnotacje (także `file`, więc ścieżka ze znakiem sterującym traci link do pliku), podsumowanie zadania i wyjście `failure`.
  - JSON i SARIF bez zmian, bo JSON sam koduje znaki sterujące. Diff `apply --dry-run` jest zmieniany tylko na terminalu albo z kolorami (nowe pole `terminal` w `CliIo`); w pliku i potoku zostaje dokładny dla `git apply`.
- **Błędy wejścia bez śladu stosu.**
  - Nieczytelny `depcurfew.json` (np. EACCES): `readPolicyFile` łapie błąd odczytu, więc to `policy-unreadable` w `apply` i `check`, problem polityki w `explain` (`policy.valid: false` z `issues`) oraz `invalid-policy` w `doctor`. Wskazówka mówi też o uprawnieniach.
  - Katalog, którego nie ma albo który jest plikiem (argument albo `check --dir`): nowe kody `directory-not-found` i `not-a-directory` w `APPLY_ERRORS` (README).
  - Tekst ma postać `error: <komunikat> (<kod>)`, problemy i `fix:`, jak `cannot-edit`; zastępuje `depcurfew: …` także przy `policy-missing` i `policy-invalid`.
  - `--json` daje dokument z `errors` w kształcie z `apply --json` i pusty stderr. `doctor --json` ma zawsze `errors`; przy błędzie `policy: null`, puste `findings`, a `summary.error` liczy też błędy, żeby odbiorca czytający samo podsumowanie widział porażkę. `apply --json` ma `policy: null`, a `explain --json` `project: null`. `doctor --sarif` daje przebieg z `executionSuccessful: false` i powiadomieniem `error` z kodem w `descriptor.id`.
  - Nowe pola: `notices` w `apply --json`, `notices` i `errors` w `explain --json`, `errors` w `doctor --json`. `schemaVersion` zostaje 1 (nowe pola i wartości).
  - Kody wyjścia: zły katalog to błąd użycia, `2` (wcześniej nieopisane `1`), co `--help` każdego polecenia mówi przy kodzie 2; nieczytelna polityka to `1`, dopisane do opisu kodu 1. „unexpected error” w `src/cli.ts` zostaje dla błędów programu.
  - SARIF w CLI i Action czyta linie plików przez `lineReader`, który przy błędzie odczytu podaje brak linii zamiast przerywać raport.
- **Polityka z katalogu nadrzędnego.** `doctor` uruchomiony w podkatalogu mówił „No problems found” z kodem 0, co w CI ze złym `working-directory` daje fałszywie zielony wynik.
  - `explain`, `apply` i `doctor` bez katalogu szukają `depcurfew.json` od bieżącego katalogu w górę do korzenia repozytorium (pierwszy katalog z `.git`, także plikiem jak w worktree) albo systemu plików i działają na katalogu z polityką. Mówią o tym: `doctor` uwagą w raporcie (tekst, JSON, SARIF), `apply` i `explain` przez `note:` na stderr albo `notices` w JSON. Bez polityki działają jak dotąd na bieżącym katalogu.
  - **Jawny katalog jest brany dosłownie, bez szukania w górę.** Użytkownik wskazał cel wprost, a `apply` zapisuje pliki w całym katalogu, więc szukanie zmieniałoby cel bez pytania. Fikstury w tym repozytorium (`node dist/cli.js doctor tests/fixtures/…`) trafiałyby też na `depcurfew.json` samego depcurfew.
  - `check` i hook korzystają z tej samej funkcji (`findPolicyDirectory` w `src/policy/file.ts`), więc też zatrzymują się na korzeniu repozytorium, bo polityka nad nim należy do innego projektu. `check --dir` nadal szuka w górę, bo wybiera tylko politykę. Wejście `directory` w Action bez zmian.
- **Action i SARIF.**
  - Gdy pliku SARIF nie da się zapisać (np. dowiązanie), Action zerował liczniki i dokładał drugi nagłówek „could not check the repository”. Teraz liczniki zostają, `failure` jest ustawione, a pod tabelą jest jedna linia `**Error:** …`.
  - Nowa linia w ścieżce nie łamie już tabeli podsumowania, bo ścieżki przechodzą przez `printable`.
  - `artifactLocation.uri` koduje procentowo każdy segment ścieżki (UTF-8, RFC 3986), a `/` zostaje.
- **Porządki prawne.**
  - README: sekcja „Trademarks” z notką wymaganą przez politykę npm („npm is a registered trademark of npm, Inc.”, `content/policies/logos-and-usage.mdx` w npm/documentation, commit 514e6c9), znakami PSF i brakiem powiązania. Doszedł akapit „Network and privacy”, a zdanie o 5000 popularnych paczkach mówi, że lista npm pochodzi z wyszukiwań w rejestrze i może być niepełna.
  - Lista PyPI: hugovk/top-pypi-packages liczy ranking z publicznego zbioru ClickPy (`"source": "ClickHouse"`), który importuje statystyki pobrań PyPI z BigQuery (README ClickPy). Opis poprawiony, razem z „30 dni” na miesiąc kalendarzowy, bo tak działa zapytanie; lista bez zmian. `source` zostaje dokumentem BigQuery w pypi/warehouse: to oficjalny opis danych, z których powstaje ranking, a ClickPy i hugovk nie są dopuszczalnymi źródłami.
  - Bundel akcji zaczyna się notą licencji ISC `yaml` (generowaną z `node_modules/yaml/LICENSE` przez `banner` w `tsdown.action.config.ts`) i odsyłaczem do THIRD_PARTY_LICENSES.md. W tym pliku doszły helpery runtime rolldown 1.2.15 (MIT, VoidZero Inc. & Contributors, z notami Rollup i esbuild z jego THIRD-PARTY-LICENSE).
  - SECURITY.md opisuje prywatne zgłoszenia przez GitHub (Security → Report a vulnerability), wspieraną najnowszą 1.x i czego się spodziewać. Prywatne zgłaszanie podatności musi włączyć właściciel w ustawieniach repozytorium.
  - Kopia schematu SARIF ma notę OASIS. `src/check/pep440.ts` wskazuje PEP 440, Appendix B (domena publiczna), jako źródło wyrażenia regularnego.

## D-079 · Poprawki po pentestcie nowego kodu przed 1.0.0 (2026-10-31)

Celowany pentest kodu z D-074–D-078 znalazł dwie podatności DoS i kilka rzeczy do utwardzenia. Wszystkie mają testy (`tests/apply/gitignore-limits.test.ts`, `tests/printable.test.ts`, `tests/security/terminal.test.ts`, `tests/cli/policy-search.test.ts`, `tests/check/command.test.ts`).

- **`.gitignore` z tysiącami segmentów `**/`.** Dopasowanie szło rekurencją po segmentach wzorca, więc jedna linia `**/` × 30 000 w `.gitignore` z PR-a przepełniała stos i przerywała `apply`, `doctor` i akcję. Dopasowanie liczy się teraz od ostatniego segmentu wstecz, wiersz po wierszu, bez rekurencji. Ostrzeżenie `file-ignored-by-git` tylko pomaga, więc wyjątek przy czytaniu `.gitignore` albo indeksu nie przerywa już `apply`: ostrzeżenia po prostu nie ma.
- **Indeks git w wersji 4.** Każdy wpis powtarza poprzednią nazwę bez prefiksu, więc indeks o rozmiarze kilku MiB mógł opisywać gigabajty nazw i zawiesić `apply`. Suma długości nazw ma limit 256 MiB; indeks ponad nim nie jest czytany (jak brak indeksu: „unless git already tracks it”).
- **Uwagi `check` o rejestrze i tagu z `.npmrc`** szły na terminal bez `printable` (D-078). Teraz są czyszczone jak reszta tekstu.
- **Znaki dwukierunkowe** (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) `printable` zapisuje jako `\uHHHH`, żeby nazwa z repozytorium nie dała się pokazać w innej kolejności (Trojan Source). D-078 tego nie obejmował.
- **Polityka z katalogu nadrzędnego tylko w repozytorium git.** D-078 szukał `depcurfew.json` w górę do katalogu z `.git` albo do korzenia systemu plików. Bez `.git` po drodze `apply` uruchomione w `/tmp/x` brało podrzucone `/tmp/depcurfew.json` i zapisywało pliki w `/tmp`, a hook mógł przyjąć cudzą, łagodną politykę. Poza repozytorium liczy się teraz tylko bieżący katalog (`--dir` w `check` też).
- **Kod interpretera z podstawienia polecenia.** `python3 -c "$(curl …)"`, `node -e "$(curl …)"`, `perl -e`, `ruby -e` i `php -r` z `$(…)` albo odwrotnymi apostrofami dają w hooku ask, jak `bash -c "$(curl …)"`. Zwykły kod w `-c`/`-e`, także ze zmienną, nadal nie jest czytany.
- **pnpm `--reporter` i `--loglevel`** są w bazie wiedzy jako opcje z wartością (pnpm.io: `cli/install.md`, `settings/cli.md`), więc `pnpm add --loglevel error lodash` nie bierze już `error` za paczkę.

Bez zmian: rejestry pod nazwą, która rozwiązuje się na adres link-local, oraz adresy prywatne i loopback zostają dozwolone (D-077), bo nazw nie rozwiązujemy, a firmowe rejestry działają w sieciach prywatnych.

## D-080 · Poprawki po przeglądzie scalonego kodu przed 1.0.0 (2026-10-31)

Przegląd poprawności po scaleniu D-074–D-078 nie znalazł nic krytycznego. Poprawione ustalenia, każde z testem:

- **`tag=` z `.npmrc` tylko dla npm.** Hook stosował go do wszystkich żądań, więc `yarn add foo`, `pnpm add foo`, `bun add foo` i `deno add npm:foo` sprawdzały wersję z tagu `beta`, choć te menedżery biorą `latest` (fakt `versionSelection` jest tylko w npm). Żądanie z innego menedżera ma teraz `ignoresConfigTag`.
- **`apply` i `before=` w `.npmrc`.** `apply` zapisywał `min-release-age` obok `before`, przy którym npm 11.15+ ignoruje opóźnienie, a npm 11.10–11.14 kończy każde polecenie błędem (fakt `beforeInteraction`). `before` to ustawienie użytkownika, więc zostaje, ale `apply` ostrzega nowym kodem `before-overrides-cooldown`, z linią i treścią zależną od wersji, tak jak `doctor` (D-076).
- **pnpm przed 10 ma listę dozwolonych.** `pnpm.onlyBuiltDependencies` w `package.json` działa od 6.32.1 (changelog pnpm: dodane w 6.32.0, „released with a bug in v6.32.0”), a każda lista, także pusta, pozwala budować tylko wymienionym paczkom (`createAllowBuildFunction` w `@pnpm/builder.policy` 3.0.0, którego używa pnpm 9.15.0). Fakt `onlyBuiltDependencies.since` był błędny (10.0.0). Dla pnpm 6.32.1–9.x przy `installScripts.default: "deny"` `apply` zapisuje teraz listę, także pustą; `scripts-not-enforceable` zostaje tylko dla wersji bez listy.
- **`cooldown-shortened` w plikach JSON.** JSON nie ma znaczników, więc wartość wpisana przez wcześniejsze `apply` liczy się jak ręczna; wskazówka mówi teraz, że po celowym obniżeniu `cooldown.minimum` nie trzeba nic robić.
- **`.npmrc` z sekcjami.** Blok wstawiany przed komentarzami pierwszej sekcji stoi teraz także nad pustymi liniami przed nimi, więc usunięcie bloku oddaje plik bez zmian. Klucz zakomentowany przez starsze `apply` pod nagłówkiem sekcji wraca, bo to inne ustawienie.
- **Komunikaty `check` o rejestrze.** Brak ostrzeżenia `insecure-registry` dla rejestru na tym komputerze (127.0.0.0/8, `::1`, `localhost`), np. lokalnego Verdaccio. Uwaga o rejestrze link-local mówi, że depcurfew go nie pyta.
- **Renovate i pnpm.** `bot-cooldown-mismatch` nie ostrzega już, że poprawki bezpieczeństwa Renovate nie przejdą przez opóźnienie pnpm ustawione w `pnpm-workspace.yaml`: Renovate sam dopisuje je wtedy do `minimumReleaseAgeExclude` (fakt `pnpmSecurityExclusions`, D-075).
- **Dokumentacja:** `requirements.txt` na liście manifestów, `--index` w tabeli poleceń, poprawione zdanie D-078 o `explain`.

Bez zmian: szukanie polityki w górę poza repozytorium git poprawił już D-079. Hook nie stosuje polityki spoza repozytorium (np. `~/depcurfew.json`); to celowe (D-078, D-079) i trafi do notatek wydania.

## D-081 · Windows: hook dla narzędzia PowerShell, cmd /c, repozytorium w korzeniu dysku, zapis przy zablokowanych plikach i CI na Windows (2026-10-31)

Przegląd zgodności z Windows (właściciel pracuje na Windows, CI testowało tylko Linux) znalazł miejsca, w których depcurfew na Windows nie działał albo dawał się obejść. Każda poprawka ma test.

- **Hook i narzędzia PowerShell i Monitor.** Według dokumentacji Claude Code (`hooks#powershell`, `tools-reference#powershell-tool`) na Windows PowerShell jest główną powłoką wszędzie, gdzie narzędzie PowerShell jest włączone, a bez Git Bash narzędzia Bash w ogóle nie ma, więc hook z matcherem `Bash` tam nie działa. Monitor (`tools-reference#monitor-tool`, z końcowego audytu bezpieczeństwa) też uruchamia polecenie powłoki, z regułami uprawnień Basha, w polu `command`; obserwacja WebSocket ma zamiast niego `ws`. Nowy fakt `claudeCode.shellTools` wymienia `Bash`, `PowerShell` i `Monitor` z powłoką każdego, `claudeCode.hooks` ma `matcherSeparator`, README podaje matcher `Bash|PowerShell|Monitor`, a hook przyjmuje zdarzenia tych narzędzi (zdarzenie bez `command` daje brak decyzji).
- **Czytnik PowerShell** (`src/check/windows-shells.ts`) rozumie tylko proste polecenia: cudzysłowy (`'…'` z `''`, `"…"` z backtickiem), dosłowne `\`, `; | && || &`, operator wywołania `&` przed wypisanym poleceniem, przekierowania (także `2>$null`), komentarze i `$env:NAZWA = wartość` jako zmienną dla dalszych poleceń (rejestr daje ask jak w POSIX).
  - Czego nie czyta (zmienne, `(…)`, `$(…)`, `@(…)`, `{…}`, `@{…}`, `[Typ]`, splatting, backtick poza kontynuacją linii, przecinek, `--%`, here-stringi, typograficzne cudzysłowy, myślniki i spacje, `Start-Process`/`saps`/`start`, `Set-Alias`, `Invoke-Command` i podobne), daje ask, gdy ta sama instrukcja (do `;`, nowej linii, `&&`, `||`) nazywa menedżer paczek, powłokę, `cmd` albo `iex`, także w napisie albo ścieżce. Instrukcja bez takiej nazwy (`Get-ChildItem | Where-Object { … }`, `if ($LASTEXITCODE -ne 0) { exit 1 }`) przechodzi bez decyzji.
  - Zawartość nawiasów jest czytana osobno, więc `& $x i lodash` w bloku daje ask jak `$CMD i lodash` w POSIX. Zmienne rejestru albo wersji ustawione inaczej niż `$env:NAZWA = …` (`Set-Item env:…`, `${env:…} = …`, `[Environment]::SetEnvironmentVariable(…)`) dają ask, gdy linia coś instaluje.
  - Znany fałszywy ask: zmienna w napisie w cudzysłowie podwójnym w instrukcji, która nazywa menedżer (`git commit -m "… $x … npm"`); napis w apostrofach go nie daje.
- **cmd.exe.** `cmd /c` i `cmd /k` (dowolna wielkość liter, `//c` z Git Bash, opcje `/s /q /d /v:on` przed, `/cpolecenie`) czyta czytnik cmd: `& && || |`, `( )`, `"…"`, `^` jako ucieczka, `%X%` i `!X!` jako rozwinięcia. Ucieczka operatora (`^&`) też liczy się jako rozwinięcie, bo plik `.cmd` czyta argumenty drugi raz. Słowo rozwijane przez wywołującą powłokę w wierszu dla `cmd /c` albo `powershell -c` daje ask.
- **Argumenty plików `.cmd`.** Fakty `windows.commandShims` (npm/cmd-shim 9.0.2: shim `.cmd` przekazuje argumenty przez `%*`; npm ma własne `bin/npm.cmd`) i `windows.batchArguments` (about_Parsing: PowerShell przekazuje argumenty plików `.bat` i `.cmd` do cmd.exe jako surowy wiersz). Argument z `& | < > "` albo końcem linii dla menedżera npm uruchomionego z PowerShell, albo dla jawnie podanego `*.cmd`/`*.bat` z każdej powłoki, daje ask: cmd.exe mógłby z niego uruchomić inne polecenie.
- **Nazwy wykonywalnych** są porównywane bez wielkości liter i bez `.exe`, `.cmd`, `.bat`, `.ps1` (`NPM i x`, `PIP.EXE install x`, `Python -m pip`), tak jak znajdują je Windows i macOS.
- **Źródła.** Nowe dozwolone lokalizacje faktów środowiska: `learn.microsoft.com` i `github.com/MicrosoftDocs/` (z tego repozytorium buduje się dokumentacja PowerShell na learn.microsoft.com; w tej sesji learn.microsoft.com był niedostępny, więc źródło wskazuje plik w MicrosoftDocs/PowerShell-Docs przypięty do commitu). Składnia PowerShell i cmd, jak POSIX, zostaje w kodzie razem z listą poleceń PowerShell uruchamiających programy (jak WRAPPERS i SHELLS, D-077).
- **Repozytorium w korzeniu dysku albo udziału** (`subst P: …`, Dev Drive, `\\nas\share\`). Granica była sprawdzana przez `startsWith(root + sep)`, co dla `P:\` daje `P:\\`, więc każdy plik był „poza repozytorium” (na Linux to samo dla `/`). Jedna funkcja `isInside` (`src/paths.ts`, przez `path.relative`, jak dotąd w akcji) służy teraz `Repository`, `Workspace`, sprzątaniu katalogów po nieudanym zapisie i akcji; na Windows nie rozróżnia też wielkości liter, jak system plików (połączenie katalogów zapisane małymi literami).
- **Ścieżki bezwzględne Windows w plikach.** `-r C:\x\req.txt`, `-r D:req.txt` i `-c \\nas\share\…` w requirements oraz wzorce workspace z dyskiem albo udziałem są „poza repozytorium” (`isAbsoluteAnywhere`), a nie „missing” czy ścieżką względną. Pojedyncza litera z dwukropkiem (`a:b.txt`) też się do tego liczy, bo na Windows to dysk.
- **Zapis `apply` przy zablokowanym pliku.** Na Windows `rename` nad plikiem, który chwilowo trzyma inny proces (skaner antywirusowy, indeksowanie, edytor), kończy się EPERM, EACCES albo EBUSY; npm (graceful-fs) w takim przypadku ponawia. `writeChanges` na win32 ponawia `rename` i usuwanie plików tymczasowych z rosnącą przerwą (10 ms do 1 s, łącznie 3,27 s, synchronicznie przez `Atomics.wait`). Platforma i czekanie są wstrzykiwane w testach.
  - Plik tymczasowy, którego nie da się usunąć, nie kończy już `apply` śladem stosu: komunikat `cannot-write` go wymienia, a wskazówka każe go usunąć.
  - Gdy nie da się przywrócić pliku, plik tymczasowy z jego wcześniejszą treścią zostaje, a komunikat i wskazówka mówią, gdzie jest.
  - Dla pliku zajętego (EBUSY, a na Windows też EPERM i EACCES) wskazówka każe zamknąć program, który go trzyma, i zdjąć atrybut tylko do odczytu (`attrib -r <plik>`) zamiast zmieniać uprawnienia.
- **Tryb nowych plików (z audytu bezpieczeństwa, regresja z D-074).** `apply` tworzył nowe pliki z trybem 0666 niezależnie od umask, bo `chmod` po utworzeniu pliku tymczasowego go omijał; przy umask 077 inny użytkownik mógł dopisać do nowego `.npmrc` np. `script-shell=`. Nowy plik powstaje teraz z 0666 zawężonym przez umask, bez `chmod`; `chmod` zostaje tylko przy zastępowaniu pliku, który dostaje swój dawny tryb.
- **Limit 1 MiB także przy edycji.** `Workspace` czytał pliki bez limitu, który ma wykrywanie (`.npmrc` 8 MiB zajmował 773 MB pamięci). Plik większy niż 1 MiB to teraz `cannot-edit` z powodem „is larger than 1 MiB, so depcurfew does not edit it”.
- **`.gitignore` bez wielkości liter.** Git for Windows i git na macOS przy `git init` i `git clone` badają system plików i ustawiają `core.ignorecase = true`; git porównuje wtedy wzorce `.gitignore` i wpisy indeksu bez wielkości liter (fakt `git.ignoreCase`: `Documentation/config/core.adoc`, `dir.c`, `config.adoc` w git 2.56.0). Ostrzeżenie `file-ignored-by-git` czyta to ustawienie z `.git/config` (sekcja i klucz bez wielkości liter, `yes`/`on`/`true`/`1` albo sam klucz) i porównuje tak samo, z wielkością liter tylko ASCII, jak git. Worktree, w którym `.git` jest plikiem, liczy się jak `false`, bo jego konfiguracja leży gdzie indziej.
- **CI na Windows.** Job `test` ma macierz `os: [ubuntu-latest, windows-latest]` × `node: [22, 24, 26]` (Node 26 jest LTS: „v26.13.0 Latest LTS” na nodejs.org/en/about/previous-releases, 2026-10-31), `fail-fast: false`, `bash` jako powłokę kroków (Git Bash na Windows) i te same przypięte akcje. `typecheck`, `check:pkg` i zgodność bundla akcji sprawdza tylko Linux, a test bundla w Vitest jest na Windows pomijany. Joby `ci.yml` i `action-test.yml` mają `timeout-minutes: 15`; pilnuje tego `tests/meta/ci.test.ts`.
  - Testy na Windows: katalog bez znaków sterujących w nazwie (NTFS ich nie dopuszcza), z trybu pliku tylko bit zapisu, sufiks ścieżki przez `join` i nazwę katalogu (krótkie nazwy 8.3 w `%TEMP%`), dowiązania do plików tylko gdy proces może je tworzyć (`canSymlink()`), dowiązania do katalogów jako `junction`. Nie da się tego uruchomić w tej sesji; pierwszy przebieg CI na Windows trzeba przejrzeć.
- **Powód decyzji hooka (z audytu bezpieczeństwa).** Treść z rejestru i repozytorium (skrypt `postinstall`, URL rejestru scope'u z `.npmrc`, komunikaty błędów) trafiała do `permissionDecisionReason` dosłownie i bez limitu: wydawca paczki mógł dopisać „NOTE FROM DEPCURFEW” dla modelu, a sekwencje sterujące i bidi trafiały do okna zgody. Każdy obcy fragment przechodzi teraz przez `printable` (nowa linia też, więc nie zacznie własnej linii) i ma najwyżej 400 znaków, cały powód najwyżej 4000 (skracane są znaleziska, nigdy wskazówka „Choose another package…”). Hook podaje tylko nazwy skryptów instalacyjnych bez treści (`scriptBodies: false`); `check` pokazuje treść jak dotąd, już czyszczoną.
- **Dane logowania w URL rejestru.** `registry=https://user:token@host/`, `@scope:registry=…`, `--registry` i `--index` tracą nazwę użytkownika i hasło (`withoutCredentials` w `src/printable.ts`) przed zapytaniem i przed każdym wyświetleniem: w `note:`, `check --json` i powodzie hooka. Zapytanie z nimi i tak by się nie udało (fetch odrzuca taki URL), a README obiecuje, że depcurfew nie wysyła danych logowania.
- **Obejścia skanera (z audytu bezpieczeństwa).** Powłoka nazwana rozwinięciem (`$SHELL -c '…'`, `"$SHELL"`, `$BASH`, `$0`, `$(which bash) -c`, `$COMSPEC //c`, `$SHELL <<< '…'`, `echo '…' | $SHELL`) dawała brak decyzji, bo rozwinięcie jako nazwę polecenia łapaliśmy tylko głębiej niż na pierwszym poziomie. Polecenie z rozwiniętą nazwą, które dostaje wiersz poleceń (po `-c`, także w grupie jak `-lc`, albo `/c`, `/k` słowo rozwijane albo ze spacją lub operatorem, here-document, here-string albo potok), daje teraz ask. `$CC -c main.c` przechodzi. `python3 -Im pip install …` (też `-Bm`, `-sm`, `-mpip`) jest czytane jak przez getopt CPythona: fakt `python.interpreter` ma `groupedShortOptions` (`Python/getopt.c` 3.14.0, `SHORT_OPTS`).
- **Polityka z katalogu nadrzędnego (z audytu bezpieczeństwa, uzupełnia D-079).** Pusty plik `.git` podrzucony w katalogu współdzielonym (np. `/tmp`) „tworzył” repozytorium, więc `apply` i hook brały podrzucone tam `depcurfew.json`. Polityka z katalogu nadrzędnego liczy się teraz tylko wtedy, gdy ten katalog należy do bieżącego użytkownika i inni nie mogą do niego pisać (bez `o+w`); na Windows ta część jest pomijana, bo właściciel i bity trybu nie mają tam tego znaczenia. Katalogi w `node_modules` są przy szukaniu pomijane, razem z ich `.git`: hook z `cwd` w `node_modules/dep/lib` brał politykę zależności. Bieżący katalog (poza `node_modules`) liczy się jak dotąd bez warunków.

## D-082 · Poprawki po przeglądzie gotowości wydania 1.0.0: pdm.lock, wskazówki w komunikatach, dokumentacja (2026-10-31)

- **PDM i `pdm.lock`.** PDM 2.29.5 sprawdza świeżość `pdm.lock` względem całej tabeli `[tool.pdm.resolution]`: obejmuje ją zarówno stary `content_hash` (`PyProject.content_hash` w `src/pdm/project/project_file.py`), jak i kanoniczne lock inputs (`lock_inputs = true`, od 2.28.1, `src/pdm/project/lockfile/freshness.py`). Po `apply` `pdm lock --check` i `pdm install --check` kończyły się kodem 1, a `apply` i `doctor` milczały.
  - Nowy fakt `lockedSettings` PDM (`settings: "table"`, polecenie `pdm lock` i polecenia, które do tego czasu zawodzą). `relockWarning` jest teraz wspólny dla uv i PDM (`src/apply/generators/python.ts`); dla PDM porównuje każdy klucz tabeli przed edycją i po niej i ostrzega `lockfile-out-of-date`.
  - Polecenia uv (`uv lock`, `uv sync --locked`, `uv lock --check`) przeszły z kodu do faktu `lockedSettings` uv, który zmienił kształt na obiekt; źródło i wnioski bez zmian.
- **Poetry i Pipenv nie mają tego problemu.** `content-hash` w `poetry.lock` (`Locker._get_content_hash`, Poetry 2.5.1) liczy tylko `[project]`, `[dependency-groups]` i klucze zależności `[tool.poetry]`, a `apply` pisze do `poetry.toml`. Hash `Pipfile.lock` (`calculate_hash` w `pipenv/utils/pipfile.py`, 2026.10.4, jak `get_hash` w plette) pomija sekcję `[pipenv]`. Potwierdziło to też odtworzenie obu algorytmów na projektach testowych.
- **Wskazówka w każdym ostrzeżeniu `apply` (zmiana D-067).** D-067 zostawiał ostrzeżenia informacyjne bez `fix`, a README i zasady projektu obiecują wskazówkę w każdym. `fix` dostały `allow-all-replaced`, `forced-source-build` (z nazwami `pypi:`), `build-switch-install-only`, `exclude-unsupported` (Pipenv), `source-switch-combined`, `security-delay-unsupported`, `tool-not-supported` (bez znanej alternatywy) i `cooldown-not-written` (`convertCooldown` zawsze podaje `fix`). Test sprawdza każdy literał ostrzeżenia w kodzie i każde ostrzeżenie w fiksturach. Znaleziska `doctor` już miały `fix`.
- **`init`.** Błędy mają postać `error: … (kod)` i `fix:`, jak inne błędy wejścia: nowy kod `policy-exists` oraz `cannot-write` dla katalogu albo dowiązania w miejscu `depcurfew.json` (wcześniej surowe `EISDIR`) i dla błędu zapisu (powód bez ścieżki bezwzględnej). Narzędzie widziane tylko w kroku CI `init` pokazuje osobno, zgodnie z `tool-only-in-ci` (D-075).
- **Brzmienie.** Przekierowanie na ten sam host innym schematem albo portem jest tak opisane, ze wskazówką użycia nowego originu; dla innego hosta komunikat się nie zmienił. `file-unreadable` nie zostawia dwukropka z pierwszej linii błędu YAML. Dla pip wskazówki mówią o plikach requirements zamiast o lockfile'u.
- **Dokumentacja.**
  - README nie ma linków względnych, bo strona npm nie otwiera plików repozytorium: baza wiedzy (także w sekcji generowanej, stała `KNOWLEDGE_DOCUMENT`), `src/index.ts`, `src/knowledge/` i LICENSE wskazują na gałąź `main` na GitHubie; pilnuje tego test.
  - Library: paczka jest tylko ESM, a `require()` działa od Node.js 22.12, w którym require(esm) jest domyślnie włączone (`doc/changelogs/CHANGELOG_V22.md` w nodejs/node, „require(esm) is now enabled by default”).
  - Poprawione niezgodności: lista plików z ochroną (też `package.json` i pliki Pythona, a opóźnienie pip w środowisku), `\u001b` w wartościach w cudzysłowie, pola ostrzeżeń i błędów `apply --json`, `version-not-pinned`, brak ostrzeżenia HTTP dla rejestru na tym komputerze (D-080), inny origin zamiast innego hosta, `sarif-file` w `action.yml` (poza workspace ścieżka bezwzględna).
- **Poza zakresem.** `doctor` nie wykrywa nieaktualnego `pdm.lock` ani `uv.lock`, bo wymagałoby to odtworzenia hasha PDM (formatowania `json.dumps` Pythona) i formatu `uv.lock`; ostrzega `apply` w chwili zmiany. Ostrzeżenia wykrywania w `explain` (np. `invalid-file`) nadal nie mają `fix`.

## D-083 · Poprawki po końcowym przeglądzie jakości i audycie DoS przed 1.0.0 (2026-10-31)

Każde ustalenie odtworzone przed i po poprawce (zapis konsoli poza repozytorium) i pokryte testem albo fiksturą.

- **`.npmrc` czytany przez `apply` jak przez npm (bezpieczeństwo).** Klucz w cudzysłowie (`"min-release-age"=0`), linia bez `=` (`dangerously-allow-all-scripts`) i część linii po samotnym `\r` omijały zarządzany blok: npm/ini zdejmuje cudzysłowy, linia bez `=` daje `true`, późniejsza wartość wygrywa, a `apply` i `doctor` milczały. `writeIniBlock` rozpoznaje klucze czytnikiem `doctor` (`iniLine`, fakt `npmrcFormat`, także nagłówek sekcji), więc zakomentowuje je jak zwykłe klucze zarządzane, a `config-drift` je zgłasza. Fikstury `npmrc-quoted-keys`, `config-drift/fires-npmrc-quoted-key`, `fires-npmrc-key-without-value`.
- **YAML bez kwadratowego testu duplikatów.** `yaml` porównywał każdy klucz z każdym wcześniejszym kluczem mapy: `pnpm-lock.yaml` 3 MB 19 s, 14 MB 6 min, 55 MB brak pamięci; `pnpm-workspace.yaml` 0,5 MiB ponad 150 s. Wszystkie pliki YAML z repozytorium idą przez `src/yaml-parse.ts`: `uniqueKeys: false` i ten sam test przez `Set` (duplikat dalej jest błędem z linią i kolumną). Zniknął też problem `.yarnrc.yml` z 8000 kluczy (13 s → 0,6 s).
  - Każdy lockfile jest czytany raz na przebieg `doctor` (pamięć podręczna na `Repository`), a linie wpisów liczone jednym przejściem, więc obie reguły widzą te same linie.
  - Lockfile YAML ponad 16 MiB nie jest parsowany: `unreadable-config` z wyjaśnieniem i poprawką. Pomiar: 16 MiB to ok. 970 MB RSS i 8 s, mieści się w stercie 1,75 GB (runner z 7 GB). Ryzyko resztkowe: złośliwie gęsty YAML (np. 2 MiB samych `1,`) zajmuje ponad 1 GB; to kończy proces błędem, czyli porażką zadania, nie fałszywie zielonym wynikiem. Pełna ochrona wymaga oszczędniejszego parsera, poza 1.0.0.
- **Głęboki YAML (audyt §8).** Kolekcje zagnieżdżone głębiej niż 256 poziomów są odrzucane przed parsowaniem jako plik nieczytelny (`invalid-file`, w `doctor` `unreadable-config`). Głębokość liczy lekser `yaml` (bez rekurencji, z cudzysłowami, komentarzami i blokami jak parser): nawiasy, wcięcia bloków i `- - -`. Wybrałem 256 zamiast proponowanego 1000, bo stos `yaml` kończy się już przy ok. 780–870 poziomach.
- **Wspólny kształt JSON przy błędnej polityce.** `check --json` podaje `policy` i `location.file` względem katalogu, w którym działa (jak `apply`), a nie ścieżką bezwzględną. `explain --json` dostał `errors` z `policy-invalid`/`policy-unreadable` z tego samego źródła co `apply`; `policy` zostaje. `doctor` zgłasza nadal znalezisko `invalid-policy` (D-069). README opisuje pola wspólne dla wszystkich poleceń. `schemaVersion` zostaje 1: pierwsze wydanie.
- **Wersja przedpremierowa.** `parseVersion` czyta `X.Y.Z-pre`, `compareVersions` porządkuje jak semver (pre przed wydaniem, identyfikatory po kolei), a `version-range` porównuje granice tą samą funkcją. `npm@11.0.0-pre.1` nie jest już konfigurowane jak npm 12.2.1.
- **SARIF.** `lineReader` dzieli każdy plik raz: 6155 znalezisk w `package-lock.json` 1 MB, `--sarif` 20 s → 0,2 s.
- **Yarn 4.17+: `npmScopes.<scope>.npmMinimalAgeGate`** (fakt `perScopeGate` w postaci strukturalnej, kod i testy akceptacyjne yarnpkg/berry 4.18.1). `broad-exclusion` zgłasza bramkę zakresu krótszą od polityki jako błąd, chyba że `cooldown.exclude` zwalnia cały zakres. Zakres wpisany bez własnej bramki dostaje domyślne `1d` zamiast globalnej (wartości domyślne kształtu w `Configuration.ts`); to wynika z kodu, bez testu, więc jest ostrzeżeniem. `apply` nie pisze bramek zakresów.
- **pnpm 12.11+: `permissions.<paczka>.build`** (nowy fakt `buildPermissions`, pnpm/pnpm v12.16.1: dokumentacja i `permissions.rs`). `true` to pozycja listy dozwolonych jak `allowBuilds: true`, a wpis `permissions` przesłania `allowBuilds` tej paczki. Czytają to `config-drift` i ostrzeżenie `apply` o pozycjach spoza polityki.
- **`apply` i pliki, których wykrywanie nie przeczytało.** `file-unreadable` obejmuje też plik ponad limitem, symlink poza repozytorium i plik bez prawa odczytu, z poprawką z tego samego źródła co `unreadable-config` (`src/doctor/unreadable-warnings.ts`).
- **Skrócone opcje pip w requirements.txt.** pip czyta plik przez optparse, który przyjmuje jednoznaczny prefiks opcji (`--no-bin :all:` to `--no-binary :all:`). Nowy fakt `requirementsParser` (pip 26.2.2, `req_file.py`): opcje parsera, także `--hash` i `-C/--config-settings`. `apply` komentuje skróconą opcję zarządzaną, a `doctor` czyta ją jako pełną: zamiast fałszywego „pip does not accept” jest `config-drift`. `--hash` w osobnej linii nie jest już zgłaszany, bo pip go przyjmuje. Do `requirementsOptions` doszło `--pypi-url`, drugie imię `--index-url`.
- **Kolejność bajtowa w wykrywaniu.** `localeCompare` zależał od ustawień regionalnych, a kolejność deklaracji decyduje o przypiętej wersji.
- **DoS czasu procesora (audyt §7).**
  - `dependabot.yml`: edycje wpisów są robione razem na tekście sprzed nich i sprawdzane raz (`yamlSetMany`). Gdy sprawdzenie zawodzi albo edycje na siebie zachodzą, są robione po kolei przez `yamlSet`, z tym samym wynikiem i błędem. Parsowania są zapamiętane. Diff ma ograniczoną pamięć i tryb przybliżony, liniowy, dla tysięcy zmian (wcześniej gigabajty pamięci). 250 wpisów: 55 s → 0,4 s; 1 MiB (ok. 9700 wpisów): ok. 13 s.
  - `renovate.json`: linie wszystkich `packageRules` z jednego parsowania (4000 reguł: 29 s → 0,15 s).
  - `requirements.txt`: linie kontynuacji sklejane przez tablicę (1 MiB: ponad 120 s → 0,8 s).

## D-084 · 1.0.0 wyszła ze starszego `main`, pełna wersja jako 1.1.0 (2026-10-31)

Tag `v1.0.0` trafił na `main` (03bdb75), zanim PR #6 przeniósł tam `faza-7`. Workflow wydania przeszedł, a właściciel zatwierdził etap, więc `depcurfew@1.0.0` ma proweniencję z tego commitu: `init`, `apply`, `doctor`, `explain` i Action dla npm, pnpm, Yarn, Bun, Deno, Renovate i Dependabota, bez `check`, hooka, Pythona i poprawek z przeglądów D-071–D-083.

- Numeru 1.0.0 nie da się użyć ponownie, także po `npm unpublish` ([polityka npm](https://github.com/npm/documentation/blob/28eb0ccc64dc/content/policies/unpublish.mdx): „Once `package@version` has been used, you can never use it again.”). Pełna wersja wychodzi jako **1.1.0**: dochodzą polecenia i obsługa Pythona, więc według semver to wersja minor, a polityka, opcje, kody wyjścia i `schemaVersion` są zgodne wstecz.
- `CHANGELOG.md` opisuje 1.0.0 tak, jak faktycznie wyszła, a resztę w 1.1.0.
- 1.0.0 zostaje w rejestrze. Po wydaniu 1.1.0 zalecane `npm deprecate depcurfew@1.0.0` z odesłaniem do 1.1.0, bo 1.0.0 nie ma poprawek z przeglądu (np. nie konfiguruje `dependabot.yml` z komentarzem po ostatnim wpisie, tylko kończy się błędem).
- `docs/RELEASING.md`: tag dopiero po scaleniu PR wydania do `main`, a przy złej treści nowa wersja i `npm deprecate`.

## D-085 · `installScripts.deny`: paczki celowo bez skryptów (2026-10-31)

- **Problem.** `doctor` na samym repozytorium zgłaszał `fsevents` (`lockfile-install-scripts`, ostrzeżenie, alert w code scanning): npm nie uruchomi jego skryptu, bo `ignore-scripts`, „a paczka może go potrzebować”. fsevents 2.3.3 ma w paczce gotowy `fsevents.node`, a skrypt `install` to `node-gyp rebuild` (sprawdzone w `npm view fsevents@2.3.3 scripts` i w zawartości tarballa, bez uruchamiania). Skrypt nie jest potrzebny, ale polityka nie miała jak tego zapisać, a dopisanie do `allow` pozwoliłoby mu działać.
- **Decyzja właściciela:** nowe pole `installScripts.deny` z listą paczek (te same wzorce co `allow`, Python z prefiksem `pypi:`). Znaczy: „sprawdzone, działają bez skryptów, skrypty zostają zablokowane celowo”.
  - `doctor` nie zgłasza takiej paczki, dopóki narzędzie nie uruchamia jej skryptów. Gdy je uruchamia (np. npm bez `ignore-scripts`), to błąd z innym brzmieniem: polityka zabrania, a narzędzie uruchamia.
  - Python: paczka z `deny` nigdy nie jest budowana ze źródeł. Gdy narzędzie i tak by ją zbudowało, to błąd. Gdy budowanie jest zablokowane, a paczka ma tylko źródła, zostaje ostrzeżenie, bo instalacja się nie uda; wskazówka mówi o paczce z kołami albo o przeniesieniu do `allow`.
  - Walidacja: `deny` przy `default: "allow"` nie działa (jak `allow`), a paczka nie może być w obu listach: ten sam wpis albo wpis jednej listy objęty wzorcem drugiej (nazwy Pythona po normalizacji).
- **Zgodność wstecz.** Nowe pole z wartością domyślną `[]`, polityka zostaje `version: 1`, a `schemaVersion` się nie zmienia. `init` zapisuje `"deny": []`, żeby pole było widać.
- **Repozytorium:** `depcurfew.json` ma `"deny": ["fsevents"]`, więc `doctor` nic nie zgłasza, a alert zamknie się po scaleniu.
- **Dalej (1.2.0):** `apply` zapisze jawną blokadę tam, gdzie narzędzie ją ma (fakty w bazie wiedzy po badaniu), żeby narzędzie samo też nie ostrzegało o pominiętych skryptach.

## D-086 · Ostrzeżenie o starszym depcurfew niż w projekcie (2026-10-31)

- **Problem (faza 11 planu).** Globalna instalacja albo stara kopia w pamięci podręcznej npx może nie znać ustawień, reguł i wersji narzędzi, które zna wersja przypięta w projekcie. Wtedy `apply` pisze mniej, a `doctor` pomija problemy albo zgłasza już naprawione.
- **Decyzja.** Wersja projektu jest czytana bez uruchamiania czegokolwiek: najpierw `node_modules/depcurfew/package.json` (kopia, którą uruchamia projekt), potem wpis `node_modules/depcurfew` w `package-lock.json`. Gdy jest nowsza niż uruchomiony depcurfew (porównanie jak semver, z wersjami przedpremierowymi):
  - `doctor`: nowa reguła `depcurfew-outdated` (ostrzeżenie, plik i linia, działa bez polityki);
  - `apply`: ostrzeżenie `depcurfew-outdated` z tym samym położeniem.
  - Wskazówka: uruchomić kopię projektu (`npx depcurfew …`) albo zaktualizować tę, którą się uruchamia.
- **Poza zakresem.** Inne lockfile'e (pnpm, Yarn, Bun) bez `node_modules`; starsza kopia w projekcie niż uruchamiana nie jest problemem.

## D-087 · Ochrona całego komputera: `init`, `apply` i `doctor --user` (2026-10-31)

- **Cel (faza 11 planu).** Polityka w konfiguracji użytkownika każdego menedżera paczek chroni każdy projekt na komputerze, który sam nie ustawia tych kluczy, oraz to, co działa poza projektem: `npx`, `uvx`, instalacje globalne i nowy projekt przed pierwszym `apply`.
- **Decyzje właściciela (2026-10-31):**
  - Polityka użytkownika to osobny plik: `~/.config/depcurfew/depcurfew.json` (`$XDG_CONFIG_HOME/depcurfew/`, gdy zmienna jest ścieżką bezwzględną; `%APPDATA%\depcurfew\` na Windows). Ten sam format co polityka projektu; `init --user` ją tworzy.
  - Wersje narzędzi są odczytywane z plików, bez uruchamiania czegokolwiek: `package.json` z polem `bin` obok pliku wykonywalnego z `PATH` (paczki npm) albo `.dist-info` z `entry_points.txt`/`RECORD` (paczki PyPI). Gdy się nie da: najnowsza znana wersja z ostrzeżeniem `version-not-pinned`, a `--for narzędzie@wersja` podaje wersję ręcznie.
- **Baza wiedzy.** Nowa sekcja `user` (typ `UserConfigKnowledge`) dla 10 menedżerów: plik per wersja i system (zmienne środowiska, katalog domowy, katalog tylko gdy istnieje), ustawienia czytane z pliku użytkownika z wersjami (`since`/`until`), zachowanie przy nieznanych kluczach i złych wartościach, osłabiające wartości i zmienne środowiska. Źródła przypięte do tagów (badanie trzech agentów, raporty w notatkach sesji).
- **Bezpieczeństwo zapisu.** Gdy narzędzie zatrzymuje każde polecenie na wartości, której jego wersja nie rozumie (`invalidValueFails`: uv, pip, Bun, pnpm, Yarn, PDM), a wersja jest nieznana, `apply --user` nic dla niego nie pisze (`version-unknown`) i mówi, jak podać `--for`. Zły plik użytkownika psułby wszystkie projekty naraz.
- **Co jest pisane.** Tylko klucze, które narzędzie czyta z pliku użytkownika, w bloku zarządzanym jak w projekcie (INI, TOML, `# managed by depcurfew` w YAML; pip w sekcji `[global]`). npm i Deno dzielą `~/.npmrc` i jeden blok. Części polityki czytane tylko z projektu (pnpm `allowBuilds`, Bun `trustedDependencies`, Yarn `dependenciesMeta`, Deno `allowScripts` i wyjątki, budowanie w PDM) dają ostrzeżenie `user-setting-project-only`. Pipenv nie ma pliku użytkownika (`no-user-config`).
- **`doctor --user`.** Reguły `user-config-drift` (plan `apply --user` ma zmiany), `user-config-weakens` (wartości z `user.weakening` poza blokiem depcurfew i poza tym, czym zarządza polityka) i `user-environment-overrides` (zmienne z `user.variables`). Bez polityki użytkownika działają dwie ostatnie. Wyjście tekst, `--json` i `--sarif` jak w `doctor`.
- **Poza zakresem 1.2.0.** `init --user` nie przenosi najdłuższego opóźnienia z istniejących plików użytkownika; wersje Yarn i Bun zainstalowanych bez npm są zwykle nieznane, więc potrzebują `--for`; zmiana macOS w platformdirs 4.6+ dla Poetry i PDM jest zapisana jako sporna, a zapis idzie do ścieżki z dokumentacji.


## D-088 · Wpisy narzędzia sprzeczne z `installScripts.allow` i `installScripts.deny` (2026-10-31)

- **Problem (przegląd przed wydaniem 1.2.0).** `apply` zmieniało w pliku narzędzia ręcznie napisany wpis dla paczki z `installScripts.deny`: `"allowScripts": { "fsevents": true }` (npm), `fsevents: true` w `allowBuilds` (pnpm, komentarz zostawał przy odwróconej linii) i `built: true` w `dependenciesMeta` (Yarn) stawały się `false`. W tym samym przebiegu `allow-list-entry-outside-policy` pisało, że `apply` nie usuwa cudzych wpisów, i radziło dopisać paczkę do `installScripts.allow`, co czyni politykę nieważną (ta sama paczka w obu listach). `doctor` (config-drift) dawał tę samą radę. W Deno było odwrotnie: wpis `npm:fsevents` w `allowScripts.deny` blokował paczkę z `installScripts.allow` (Deno uruchamia skrypty, gdy paczka jest na liście allow i nie ma jej na liście deny: `can_run_scripts` w libs/npm_installer/lifecycle_scripts.rs w v2.9.8), a `doctor` nic nie zgłaszał.
- **Decyzja (`apply` nigdy nie zmienia ustawień, którymi nie zarządza):** `apply` nie odwraca takich wpisów i nie zapisuje odmowy dla paczki, którą wpis listy narzędzia dopuszcza (zapisanie `fsevents: false` obok `fsevents@2.3.3: true` zmieniłoby działanie wpisu, bo w npm i Deno odmowa wygrywa; w Yarn wpis z wersją wygrywa z wpisem bez wersji: `Project.getDependencyMeta` w 4.18.1). Zamiast tego ostrzeżenie `deny-conflicts-with-file` z plikiem, linią, wpisem i wskazówką: usunąć wpis z pliku albo przenieść paczkę między listami polityki po przeglądzie. Dotyczy to też wpisu, który blokuje paczkę z `installScripts.allow` i zostaje po `apply` (Deno `allowScripts.deny`, pnpm `permissions.<paczka>.build: false`, wpisy `false` z wersją). Żadna wskazówka nie radzi dopisać do `allow` paczki z `deny`.
  - `doctor` zgłasza to samo w `config-drift` (ostrzeżenie), liczone na plikach po zaplanowanym `apply`, żeby nie powtarzać zmian, które `apply` i tak zrobi.
  - `lockfile-install-scripts` uwzględnia listy narzędzia w wersji, która je czyta: wpis allow uruchamia skrypty (błąd także w npm 12, gdzie wcześniej padało „npm will not run”), a zapisana odmowa (`extra.denyList`, np. `false` w `allowScripts` od npm 11.16.0, `#addToBuildSet` w arborist/lib/arborist/rebuild.js) znaczy, że skrypty nie działają, także bez `strict-allow-scripts`.
- **Przy okazji.** `check` i hook Claude Code nie zgłaszają błędu dla paczki z `deny` (paczka Pythona bez kół: ostrzeżenie, że instalacja się nie uda tam, gdzie budowanie jest zablokowane). Walidacja nie porównuje wzorców npm z nazwami `pypi:`, a odrzuca dwa wzorce, które pasują do wspólnej nazwy (`foo-*` i `*-bar`), z przykładem tej nazwy. pnpm 10.1–10.25 dostaje `ignoredBuiltDependencies` (changelog 10.26.0 nazywa `allowBuilds: false` tym samym), starsze `version-too-old`.
- **Zgodność wstecz.** Nowe kody ostrzeżeń `deny-conflicts-with-file` i `unexpected-value` (Deno: `allowScripts.deny`, które nie jest listą, zostaje i nie jest zastępowane); `allow-list-entry-outside-policy` dostaje linię w `location`. `schemaVersion` bez zmian.
