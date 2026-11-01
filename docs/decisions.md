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
- **Poza kodem:** rejestr npm pokazuje publicznie nazwę i mail opiekuna paczki (pole `maintainers`), a historia commitów na GitHubie - dotychczasowych autorów.
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
- **Hatch (1.18.2): bez generatora.** Hatch nie ma własnych ustawień opóźnienia, budowania ani źródeł; jego środowiska instalują przez uv albo pip. Projekt Hatch z instalatorem uv obsługuje istniejący generator uv (`"uv"` w `targets`, bo uv czyta `[tool.uv]` także pod Hatchem), a środowiska z pip - zmienne środowiskowe pip. README to opisuje; osobne wykrywanie Hatch nie dawałoby nic do skonfigurowania.
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

## D-089 · `doctor --user` po przeglądzie przed 1.2.0: treść zamiast celów polityki, pliki nadrzędne, fail closed (2026-10-31)

- **Osłabiające wartości a polityka.** `user-config-weakens` pomija klucz tylko wtedy, gdy ten sam klucz z tą samą wartością (w INI także w tej samej sekcji) stoi w zarządzanej treści pliku po planowanym `apply --user` (blok depcurfew, znacznik YAML). Wartości poza blokiem są sprawdzane zawsze; bez polityki, dla narzędzia pominiętego (`version-unknown`, `no-user-config`, poza `targets`) i dla pliku, którego plan nie umie edytować, także wartości w bloku. Dawne pomijanie po celach polityki (`coveredPurposes`) chowało wartości, których generatory nie piszą (puste listy, narzędzia z nieznaną wersją). Reguła opiera się na treści, więc zostaje poprawna, gdy zmienia się to, co pisze `apply --user`.
- **Miejsca nadrzędne w bazie wiedzy.** `UserFile.sections` (INI: sekcje, które narzędzie czyta; npm tylko klucze nad pierwszym nagłówkiem, pip `[global]` i sekcje poleceń z tymi opcjami) i `UserFile.overriddenBy` (pnpm 10 czyta `~/.npmrc` przed `rc`). W pliku nadrzędnym raportowane są wartości z `weakening` oraz klucze, które `apply --user` pisze do pliku użytkownika, gdy mają inną wartość. Tabela `[pip]` w `uv.toml` to zwykłe klucze `pip.*` w `weakening`. Bez wersji sprawdzane są pliki wszystkich wersji narzędzia.
- **Zmienne środowiska.** `src/user/variables.ts` (`environmentOverrides`): każda niepusta pisownia, nazwa taka jak w środowisku, wersje (`UserVariable.since`/`until`), `defaultPath` (wartość wskazująca domyślny plik nic nie zmienia; npm eksportuje `npm_config_userconfig` do uruchamianych poleceń) oraz wartości, które npm (marker `npm_execpath`, `npm.extra.childEnvironment`) przekazał z `~/.npmrc`. Wartość zmiennej trafia do komunikatu tylko wtedy, gdy baza wiedzy wymienia wartości osłabiające; zmienne „any” są podawane z samą nazwą (mogą zawierać dane logowania). Flagi uv (`UV_NO_BUILD`, `UV_NO_BINARY`, `UV_NO_CONFIG`) liczą się tylko z wartościami prawdziwymi według `BoolishValueParser`.
- **Fail closed.** Plik, którego nie da się przeczytać, sparsować lub zaplanować (symlink, ponad 1 MiB, katalog, zduplikowany klucz YAML, bomba aliasów), to błąd `user-config-unreadable`, a nieprawidłowa polityka użytkownika to błąd `user-policy-invalid` (kod wyjścia 1, jak `unreadable-config` i `invalid-policy` w projekcie). Osobne identyfikatory, bo README wymienia reguły obu trybów pod nagłówkami z identyfikatorem.
- **Wersje z plików.** `package.json` znaleziony przy pliku wykonywalnym liczy się tylko wtedy, gdy to paczka samego narzędzia (`name` równe narzędziu albo zakres `@<narzędzie>/`). Shimy corepack mają wersję nieznaną; Yarn Berry zainstalowany jako `@yarnpkg/cli-dist` też (rzadkie, `--for` wystarcza). `version-too-old` z planu jest w `doctor --user` notatką, jak `version-unknown`.
- **SARIF.** Pliki pod katalogiem domowym mają `uriBaseId: "HOME"` z opisem w `originalUriBaseIds`, bez ścieżki (nazwa konta); pliki poza nim bezwzględny URI `file:`; zmienne to `logicalLocations` o rodzaju `variable`. W JSON nowe pole `location.variable`. JSON i SARIF `doctor` przechodzą przez `safeJson` (C1 i znaki bidi jako `\uXXXX`).

## D-090 · `apply --user` obchodzi się z kluczem w pliku użytkownika tak jak `apply` z tym samym kluczem w projekcie (2026-10-31)

- **Zasada.** Przed wydaniem 1.2.0 przegląd znalazł miejsca, w których `apply --user` milczał tam, gdzie `apply` w projekcie ostrzega albo zastępuje wartość. Teraz obowiązuje zgodność z trybem projektu: co projekt zastępuje lub zgłasza dla klucza w pliku projektu, to tryb `--user` zastępuje lub zgłasza dla tego samego klucza w pliku użytkownika.
- **Listy przy pustej liście polityki.** Listy wyjątków od opóźnienia (pnpm 10 `minimum-release-age-exclude`, Poetry `solver.min-release-age-exclude`) i listy budowania Pythona (Poetry `installer.no-binary`, jak już uv i pip) są zarządzane także wtedy, gdy polityka nic nie wymienia: ręczna wartość zostaje zakomentowana i wraca, gdy polityka przestaje nią zarządzać. W YAML (pnpm 11+ `minimumReleaseAgeExclude`, Yarn `npmPreapprovedPackages`) istniejąca lista dostaje listę polityki, także pustą, jak w `pnpm-workspace.yaml` i `.yarnrc.yml` projektu. Listy dopuszczonych skryptów (npm `allow-scripts`, pnpm 10 `only-built-dependencies`) zostają, a każdy wpis spoza polityki daje `allow-list-entry-outside-policy`; gdy polityka ma własną listę, blok ją zapisuje, a ręczna linia jest zakomentowana jak dotąd.
- **Sekcje pip i tabela `[pip]` uv.** Sekcja polecenia w `pip.conf` (`[install]`) wygrywa z `[global]` (fakt `pip.extra.configSections`), więc zarządzane klucze są komentowane we wszystkich sekcjach poza `[global]`. `uv pip` stawia `[pip]` ponad kluczami najwyższego poziomu (fakt `uv.extra.pipTable`, kod `PipSettings::combine`), więc `[pip] exclude-newer`, `exclude-newer-package` i `no-binary` są komentowane, gdy depcurfew zarządza odpowiednim kluczem najwyższego poziomu.
- **`before=` w `~/.npmrc`.** Dla npm 11.10–11.14 `apply --user` nie pisze `min-release-age` obok `before=` (także dla Deno, które dzieli linię), bo npm zatrzymałby wtedy każde polecenie na komputerze; ostrzeżenie `before-overrides-cooldown` każe usunąć `before`. To odstępstwo od D-080 (projekt pisze i ostrzega): plik użytkownika psuje wszystkie projekty naraz, jak przy `invalidValueFails` w D-087. Od 11.15 wartość jest pisana, a ostrzeżenie mówi, że `before` ją zastępuje.
- **Ostrzeżenia trybu projektu.** `cooldown-shortened` (z plikiem polityki użytkownika i `depcurfew apply --user` w poprawce), `scripts-not-enforceable`, `forced-source-build`, `build-switch-scope`, `source-not-enforceable`, `allow-pattern-unsupported`, `exact-version-gap`, `source-switch-indirect-only`, `source-switch-combined` i `allow-all-unsupported` (Bun). Klucz, który narzędzie czyta tylko z projektu (pnpm 12 `blockExoticSubdeps`, jawne odmowy `installScripts.deny` w npm, pnpm i Yarn), daje `user-setting-project-only`, a nie `source-not-enforceable`, bo `depcurfew apply` w projekcie go zapisuje. Yarn 1.x nie czyta `~/.yarnrc.yml` (fakt `yarn.extra.classicUserFile`): `tool-not-supported`.
- **`version-too-old`.** Klucz jest sprawdzany tylko wtedy, gdy polityka czegoś od niego chce (pusta lista wyjątków, `minimumReleaseAgeStrict`, `strictDepBuilds` nie dają ostrzeżenia). W trybie `--user` poprawka mówi „Update X to N or later, then run depcurfew apply --user again”, a wersja w komunikatach jest taka, jak ją podaje narzędzie (pip 24.0), gdy została odczytana z plików (opcja `user` w `createContext`).
- **Znacznik bloku.** W plikach użytkownika blok zaczyna się od `# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead`. Parser rozpoznaje oba teksty (z etykietą tabeli i bez), więc blok zapisany wcześniej znacznikiem projektu jest zastępowany, a `doctor` uznaje oba za zarządzane.
- **Puste linie w TOML.** Blok najwyższego poziomu dostaje pustą linię po sobie tylko przed nagłówkiem tabeli; klucz zapisany tuż pod blokiem zostaje na miejscu, a blok pip zostaje w swoim miejscu sekcji, więc drugie `apply` niczego nie przesuwa (dotyczy też trybu projektu).

## D-091 · `apply --user` po przeglądzie 1.2.0: zapis, komunikaty i to, co widać w diffie (2026-10-31)

- **Wszystko albo nic przez wiele katalogów.** Pliki użytkownika leżą w różnych katalogach (każdy to osobny korzeń `Workspace`), więc `writeUserChanges` pisał je korzeń po korzeniu i przy błędzie drugiego zostawiał pierwszy zmieniony. Nowe `writeChangeSets` robi to, co `writeChanges`, dla wielu korzeni naraz: najpierw wszystkie pliki tymczasowe, potem zamiany, a przy błędzie przywraca już zamienione. `writeChanges` jest jego przypadkiem z jednym korzeniem.
- **Żaden plik nie znika po cichu.** Błąd odczytu pliku użytkownika poza `context` (pip edytuje przez `workspace.edit`) trafiał do pustego `catch`; teraz każdy wyjątek inny niż `EditFailed` z kontekstu jest zapisywany jako błąd `cannot-edit` tego narzędzia. `Workspace` nazywa też część ścieżki, która jest plikiem zamiast katalogu (`~/.config/pip is not a directory`).
- **Gdzie, po ludzku.** `Workspace` i `writeChangeSets` dostają funkcję nazywającą plik; w trybie `--user` to ścieżka pokazywana użytkownikowi (`~/.config/uv/uv.toml`) w tekście i w `location.file`, z nazwą narzędzia i `cannot edit` jak w projekcie, a poprawki mówią `depcurfew apply --user`. JSON błędu `cannot-edit` ma `location.line`, gdy parser podaje linię (nowe pole, ten sam `schemaVersion`).
- **Ścieżki, których nie znamy, i katalog domowy.** Zmienna katalogu (`XDG_CONFIG_HOME`, `APPDATA`) ze ścieżką względną jest pomijana tylko tam, gdzie baza wiedzy ma `absolute: true` (uv, Bun, npm na Windows). Dla pozostałych nie wiadomo, gdzie narzędzie wtedy szuka, więc `apply --user` nic dla nich nie pisze (`user-directory-relative`), a `userFilePath` zwraca `undefined`, żeby nikt nie czytał pliku względem bieżącego katalogu. Brak katalogu domowego to błąd `home-missing` zamiast `mkdir -p` (użytkownicy systemowi mają `HOME=/nonexistent`). `--for` dla narzędzia, którego `apply --user` nie konfiguruje, daje `version-not-used`; `--for` przyjmuje wersję z dwóch części (pip 26.1 → 26.1.0), tak jak odczyt z `.dist-info`.
- **Właściciel pliku pod `sudo`.** Gdy depcurfew działa jako root, a zastępowany plik należy do kogoś innego, plik tymczasowy dostaje jego uid i gid przed zamianą. `chown` i `chmod` działają na otwartym deskryptorze (`fchown`, `fchmod`), bo po nazwie root poszedłby za dowiązaniem, które właściciel katalogu mógł tam podłożyć, i oddałby mu cudzy plik. Nowe pliki i katalogi zostają własnością roota, jak w każdym programie.
- **Sekrety w diffie.** Diff (`--dry-run`, `changes[].diff`) pokazuje `<redacted>` zamiast wartości kluczy, które trzymają sekrety, w każdej linii (kontekst, usunięta, dodana): `_auth`, `_authToken`, `_password` z `.npmrc`, także z przedrostkiem `//host/:` (lista kluczy uwierzytelniania i zakres przez przedrostek: https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/npmrc.md, sprawdzone 2026-10-31), klucze kończące się na `token`, `password` lub `secret` i `npmAuthIdent` w dowolnym formacie oraz `user:hasło@` w adresach URL. To wzorzec do ukrywania wartości, a nie ustawienia, które depcurfew pisze lub czyta, dlatego żyje w `src/apply/diff.ts`, a nie w `src/knowledge/`; myli się w stronę ukrycia. Odwołanie do zmiennej (`${NPM_TOKEN}`) zostaje widoczne. Pliki na dysku są nietknięte, a diff z ukrytą linią w kontekście może nie dać się nałożyć przez `git apply`; bezpieczeństwo wygrywa. Funkcja biblioteczna `unifiedDiff` ukrywa tylko z `{ redact: true }`.
- **Znaki sterujące.** Nazwy plików w nagłówkach diffu przechodzą przez `printable` zawsze (także w potoku), żeby ścieżka z `XDG_CONFIG_HOME` nie dopisała fałszywych linii `+++` czy `@@`. JSON na stdout (`apply`, `explain`, `check`, a u agenta B `doctor`) idzie przez `safeJson` z `src/json-safe.ts`, który zamienia znaki C1, znaki dwukierunkowe i separatory linii na `\uXXXX`, bo `JSON.stringify` ich nie ucieka.
- **Zamknięty potok.** `depcurfew … | head -1` kończył się nieobsłużonym `EPIPE` ze śladem stosu. `src/cli.ts` po `EPIPE` po cichu porzuca resztę wyjścia, a kod wyjścia pozostaje kodem polecenia.

## D-092 · Przełączniki, które wyłączają ochronę, klucze scalania YAML, `[pip] no-build` w uv i drobne poprawki trybu projektu (2026-10-31)

- **Problem (przegląd 1.2.0, odtworzony z pnpm 10.28.0).** pnpm sprawdza `dangerouslyAllowAllBuilds` testem prawdziwości, więc `"false"` (tekst), `yes` i `"true"` w `pnpm-workspace.yaml` uruchamiały skrypty zależności, a `apply` je zostawiało i `doctor` milczał; tak samo `dangerously-allow-all-builds=yes` lub `=1` w `~/.npmrc` (`doctor --user`) i `npm_config_dangerously_allow_all_builds=1`. depcurfew porównywał te wartości z `true`. Klucz scalania YAML (`<<: *d`) w `pnpm-workspace.yaml` i w `config.yaml` pnpm przenosił `dangerouslyAllowAllBuilds: true` niewidocznie dla depcurfew, bo pakiet `yaml` bez `merge: true` czyta `<<` jako zwykły klucz.
- **Decyzja: fail closed dla przełączników, które wyłączają ochronę.** Baza wiedzy podaje wartości, które narzędzie czyta jako wyłączone (`values: { except: [...] }` w `user.weakening` i `user.variables`, `off` w `extra.allowAllBuilds`); każda inna wartość liczy się jako włączona. W INI i zmiennych środowiska porównywany jest tekst po przycięciu, w YAML, TOML i JSON wartość z typem. Sprawdzone w kodzie przypiętych wersji (źródła przy faktach):
  - pnpm 10 (`.npmrc`, `rc`, `npm_config_*`): `parseField` z @pnpm/npm-conf 3.0.2 i 3.0.3 zamienia tylko `false`, `null` i `undefined` w wartości fałszywe, pusta wartość ustawienia Boolean to `true`, a `1`, `0`, `yes` zostają tekstem, czyli prawdą; pnpm 10 i 11 w YAML kopiują wartość bez sprawdzania typu, więc wyłączone są tylko `false`, `0`, `null` i `""`; pnpm 12 czyta `Option<bool>` słowami YAML 1.1 z serde-saphyr i na inną wartość kończy się błędem. `pnpm_config_*` w pnpm 11 (`parseBoolean` w env.ts) przyjmuje jako prawdę tylko `true`, więc zostaje listą `['true']`.
  - npm 11.21.1: `parse-field.js` jak wyżej, `load()` nie uruchamia sprawdzania typów nopt (`validate()` działa tylko w `npm config`), arborist testuje prawdziwość `dangerouslyAllowAllScripts`.
  - Yarn 4.18.1: każda wartość `.yarnrc.yml` to tekst (FAILSAFE_SCHEMA), `parseBoolean` przyjmuje `true`/`1` i `false`/`0`, a na inną wartość Yarn się zatrzymuje; zgodnie z zasadą liczy się jako włączona (`enableScripts: 1` było dotąd pomijane). PDM 2.29.5: `use_uv` przez `ensure_boolean`. Deno 2.9.8: tylko JSON `true` włącza `allowScripts`, tekst lub liczba to błąd, więc porównanie z `true` zostaje. `trustLockfile` (pnpm 11.3+) bez zmian: nie sprawdzono, jak pnpm odczytuje tę wartość.
  - `apply` zastępuje `dangerouslyAllowAllBuilds` każdą wartością spoza `off`; ostrzeżenie `allow-all-replaced` ma teraz `location` i podaje wartość. Dla pnpm 10.9–10.x `dangerously-allow-all-builds` w głównym `.npmrc` działa, dopóki `pnpm-workspace.yaml` nie ma własnych ustawień budowania (od 10.13.0 `hasDependencyBuildOptions`, fakt `extra.npmrcBuildSettings`): `apply` zostawia tę linię (nie zarządza nią) i zapisuje `dangerouslyAllowAllBuilds: false` w `pnpm-workspace.yaml`, które pnpm czyta przed `.npmrc`; `doctor` zgłasza linię w `npmrc-overrides-policy`. Pole `"pnpm"` w `package.json` nie jest sprawdzane, co myli się w stronę zgłoszenia.
- **Klucze scalania YAML.** Fakt `extra.yamlMergeKeys`: pnpm stosuje `<<` (read-yaml-file z @zkochan/js-yaml i domyślnym schematem w 10.28.0, 10.34.9 i 11.28.10, serde-saphyr z `MergeKeyPolicy::Merge` w 12.16.1; sprawdzone też `pnpm config get` w 10.28.0), Yarn nie (FAILSAFE_SCHEMA, a `<<` to dla niego nieznany klucz), Dependabot nie wiadomo (`uncertain`). Plik użytkownika ma `UserFile.mergeKeys` (`config.yaml` pnpm). depcurfew czyta z kluczami scalania tylko pliki narzędzi ze zweryfikowanym `true` (`parseYamlDocument(…, { merge: true })`, `yamlOptionsFor` w `src/apply/facts.ts`, kontekst generatora według narzędzia), resztę jak dotąd. `dependabot.yml` bez scalania jest fail closed: cooldown dostępny tylko przez `<<` liczy się jako brak, który `bot-cooldown` zgłasza, a `apply` wpisuje cooldown do samego wpisu. Renovate nie czyta YAML.
  - Semantyka jak w loaderach: klucz zapisany w mapie wygrywa ze scalonym bez względu na kolejność (js-yaml `mergeMappings`, serde-saphyr), wcześniejsze mapy listy `<<: [*a, *b]` wygrywają z późniejszymi, `"<<"` w cudzysłowie to zwykły klucz. `apply` pisze wartość do samej mapy, a nie do mapy z kotwicą (której nie zarządza); scalona wartość, która już jest właściwa, niczego nie zmienia, więc drugie `apply` też nie. Do mapy, która w całości przychodzi przez `<<`, `apply` nie pisze (`cannot-edit` z linią `<<`), bo jawny klucz zastąpiłby całą scaloną mapę. Klucz scalania, który nie wskazuje mapy (js-yaml: „cannot merge mappings”), to błąd pliku (`unreadable-config`, `user-config-unreadable`). Komunikaty podają linię wartości i linię `<<`.
- **uv `[pip] no-build = false` niczego nie osłabia.** `PipSettings::combine` przekazuje go do `NoBuild::from_pip_args`, które dla `false` daje `None` (albo listę `only-binary`) i łączy to z `no-build`/`no-build-package` najwyższego poziomu przez `NoBuild::combine` (`All` wygrywa), tak samo w 0.9.17 i 0.13.6. Wpis `pip.no-build` usunięty z `uv.user.weakening`, zgodnie z `extra.pipTable`; `apply --user` go zostawia, a `doctor --user` go nie zgłasza.
- **Drobne poprawki trybu projektu.**
  - Tekst konfliktu z `installScripts.deny` (`deny-conflicts-with-file`, `config-drift`) mówi, że wpis pozwala uruchamiać skrypty, choć polityka mówi, że nie powinny działać (dawne „blocks them” sugerowało, że nie działają). W `config-drift` taki wpis jest błędem, jak różnice, które naprawia `apply`; wpis dla paczki, której polityka nie wymienia, i wpis blokujący paczkę z `installScripts.allow` zostają ostrzeżeniami (`apply` ich nie zmienia, więc `doctor` zaraz po `apply` nie kończy się błędem z ich powodu).
  - `config-drift` nazywa brakujące ustawienie JSON ścieżką (`allowScripts is missing; depcurfew apply adds …`) zamiast pierwszej dodanej linii diffu (`}`), wymienia wszystkie linie `.npmrc` spoza bloku, które `apply` zakomentuje, a przy wartości w cudzysłowie (`"false"`) dopisuje, że to tekst.
  - `.npmrc`, które istnieje, ale nie jest zwykłym plikiem (nazwany potok), daje ostrzeżenie detekcji `not-a-regular-file`: `explain` pokazuje „.npmrc (not a regular file, not read)”, `doctor` zgłasza błąd `unreadable-config`, `apply` ostrzeżenie `file-unreadable`.
- **Zgodność wstecz.** Nowe pola bazy wiedzy (`except`, `off`, `mergeKeys`, `yamlMergeKeys`, `npmrcBuildSettings`), nowy kod ostrzeżenia detekcji, `location` w `allow-all-replaced` i poziom `error` dla konfliktu z `deny` w `config-drift` to nowe wartości istniejących pól; `schemaVersion` bez zmian.

## D-093 · `--user` po drugim przeglądzie 1.2.0: katalog domowy, właściciel nowych plików, ścieżki względne i komunikaty (2026-10-31)

- **Katalog domowy wspólny dla trzech poleceń.** Sprawdzenie z D-091 żyje w `src/user/home.ts` (`homeProblem`). `init --user` bez katalogu domowego kończy się błędem `home-missing` także wtedy, gdy bezwzględne `XDG_CONFIG_HOME` dałoby miejsce na politykę, bo `apply --user` i tak by jej nie użyło; wcześniej `init --user` tworzył `/nonexistent` jako root. `doctor --user` zgłasza brak katalogu domowego jako błąd `user-config-unreadable` (z polityką i bez niej), a każdy `problem` planu `apply --user` staje się takim błędem; „No problems found” przy braku katalogu nic nie znaczyło. Część ścieżki, która jest plikiem (`~/.config`), i `EACCES` przy `lstat` to zwykłe błędy `cannot-write` z nazwą i poprawką zamiast śladu stosu.
- **Właściciel nowych plików pod `sudo`.** Odstępstwo od D-091 („nowe pliki i katalogi zostają własnością roota”): gdy root pracuje w katalogu domowym innego użytkownika, `init --user` i `apply --user` oddają mu pliki i katalogi, które tworzą pod tym katalogiem, bo inaczej użytkownik nie mógł potem zmienić własnej konfiguracji ani uruchomić `init --user --force`. `writeChangeSets` dostaje `ownerOfNew`, pytane o prawdziwą ścieżkę (realpath), więc to, do czego dowiązanie prowadzi poza katalog domowy, zostaje rootowi; pliki poza katalogiem domowym (bezwzględne `XDG_CONFIG_HOME` gdzie indziej) też. Katalogi powstają po jednym poziomie: po `mkdir` `lstat` sprawdza, że to katalog roota, potem `lchown` (nie idzie za dowiązaniem) i ponowny `lstat` z tym samym i-węzłem; pliki dostają `fchown` na deskryptorze jak w D-091.
- **Względne `XDG_CONFIG_HOME` u pip.** Nowe pole `relativeToCwd` w `UserDirectory`: pip bierze wartość tak, jak jest, więc czyta `<wartość>/pip/pip.conf` względem katalogu, w którym działa polecenie (`XDGMixin.user_config_dir` w vendorowanym platformdirs `_xdg.py` w pip 26.2.2 bez sprawdzania ścieżki bezwzględnej, `appdirs.py` i `configuration.py` niczego nie rozwiązują; to samo w 26.1.1 w `unix.py`; https://github.com/pypa/pip/blob/26.2.2/src/pip/_vendor/platformdirs/_xdg.py, sprawdzone 2026-10-31). `apply --user` dalej nic nie pisze (każdy katalog to inny plik), ale ostrzeżenie mówi, co pip robi. `doctor --user` zgłasza zmienną w `user-environment-overrides` (narzędzia, które czytają plik z bieżącego katalogu, i te, o których nie wiadomo, gdzie szukają) i sprawdza plik, który pip przeczytałby z bieżącego katalogu (`UserEnvironment.cwd`). Dla Poetry, PDM i pnpm zachowanie nie jest sprawdzone, więc zostaje samo ostrzeżenie.
- **Plik czytany przed plikiem użytkownika.** `apply --user` porównuje klucze, które zapisuje (zarządzana treść po planie), z plikami z `UserFile.overriddenBy` (pnpm 10: `~/.npmrc` przed `rc`) w stanie po tym samym przebiegu i ostrzega `user-setting-overridden` z plikiem, linią, kluczem i poprawką. `doctor --user` liczy to samo także wtedy, gdy `rc` jeszcze nie istnieje (brakujący plik ma pustą listę kluczy, a plan wnosi to, co `apply --user` by zapisało).
- **Diff w tekście.** Każda linia diffu w wyjściu tekstowym przechodzi przez `printable` (z zachowaniem `+`, `-` i spacji), także w potoku: wartość z pliku nie może sterować terminalem ani logiem CI. W potoku zostaje tylko CR przed LF (koniec linii CRLF), żeby diff pliku z końcami linii Windows dalej dał się nałożyć; na terminalu i on jest pokazany jako `\x0d`. Diff w JSON zostaje dokładny. Plik o ścieżce bezwzględnej ma w nagłówkach samą ścieżkę (`+++ /tmp/cfg/uv/uv.toml`) zamiast `b//tmp/...`.
- **Komunikaty.** Plik, którego `apply --user` nie umie edytować, ma poprawkę dla swojego problemu (dowiązanie, ponad 1 MiB, nie UTF-8, katalog, FIFO, część ścieżki będąca plikiem, brak uprawnień, błąd składni TOML lub YAML z linią); `Workspace.problem` zapisuje przyczynę, a `doctor --user` podaje tę samą poprawkę. Komunikaty `doctor --user` nazywają narzędzie raz: zakres wersji z końca efektu w bazie wiedzy („(pnpm 11+)”) staje po pliku, efekt, który sam nazywa narzędzie, nie dostaje dopisku, a zakres („in every project…”) bez osieroconego przecinka. Dane logowania w adresach są w `doctor --user` pokazane jak w diffie (`https://<redacted>@host`), żeby było widać, że tam były (`redactCredentials` w `src/printable.ts`; `withoutCredentials` zostaje dla adresów, które depcurfew wysyła). `user-policy-invalid` dla błędnego JSON ma linię w `location`. `--for` dla narzędzia spoza `PATH` daje w `doctor --user` notatkę (jak inne ostrzeżenia planu w D-089), a nie ciszę.
- **Zgodność wstecz.** Nowy kod ostrzeżenia `user-setting-overridden`, nowe pola wewnętrzne (`UserFailure.fix`, `RelativeDirectory.file` i `path`, `UserEnvironment.cwd`); `schemaVersion` bez zmian.

## D-094 · `doctor` mówi, co sprawdził (2026-10-31)

- **Problem.** Czysty wynik wyglądał jak brak działania: w code scanning GitHub pokazuje tylko alerty, więc wpis „depcurfew” był pusty, a w logu stało samo „No problems found.”. Właściciel: „musi być jakaś informacja, jeśli wszystko jest ok, i log tego, co zostało sprawdzone”.
- **Decyzja.** Raport `doctor` i `doctor --user` ma pole `checked`: narzędzia z wersją, względem której sprawdzano, i jej źródłem, przeczytane pliki i każda kontrola z wynikiem (`passed`, `problems` z liczbą błędów, ostrzeżeń i uwag, `skipped`, gdy potrzebuje brakującej polityki). Każda reguła ma zdanie `checks`, które mówi zwykłym językiem, co sprawdza („Configuration files match what depcurfew apply writes for depcurfew.json”). Tekst pokazuje listę pod wynikiem, także przy znaleziskach. Action pisze ją w logu, w tabeli „What was checked” podsumowania zadania i, gdy nie ma znalezisk, w jednej adnotacji `notice` z tą samą listą, escapowanej jak inne adnotacje. Właściciel: „obecnie nie wiadomo, co to w ogóle robi; co sprawdziło”.
- **Pliki przeczytane** to pliki znane wykrywaniu (dowody, konfiguracja, `.npmrc`, workflowy, deklaracje workspace’ów, polityka) i pliki, które reguły przeczytały przez `Repository` (`Repository.read`); w `--user` pliki użytkownika, które doctor przeczytał, i polityka użytkownika.
- **Zgodność wstecz.** Nowe pole w JSON, bez zmiany `schemaVersion`; SARIF bez zmian (code scanning i tak nie pokazuje przebiegów bez wyników).

## D-095 · Wpis „depcurfew doctor” w zakładce Checks (2026-10-31)

- **Problem.** Wpis code scanning przy PR pokazuje tekst GitHuba („No new alerts in code changed by this pull request”) i wyłącznie alerty; żaden program wysyłający SARIF nie może go zmienić, a zgłaszanie udanych kontroli jako alertów zaśmieciłoby zakładkę Security. Właściciel chciał wynik i rozpiskę kontroli „gdzieś w tym miejscu”.
- **Decyzja.** Action tworzy obok własny check run „depcurfew doctor” (z katalogiem w nazwie, gdy nie jest korzeniem workspace’u) przez Checks API (`environment.githubActions.checkRuns`, źródła: opis REST API GitHuba i github/docs). Tytuł to wynik i liczba kontroli („No problems found (13 checks: 13 passed)”), treść to podsumowanie zadania (znaleziska i tabela kontroli) przycięte do 65535 znaków. Wniosek: `failure` przy błędach (`neutral`, gdy `fail-on-error: false`), `neutral` przy ostrzeżeniach, `success` w pozostałych przypadkach; `failure` także, gdy doctor nie mógł działać.
- **Commit.** Przy `pull_request` `GITHUB_SHA` to commit scalenia, więc wpis idzie na `pull_request.head.sha` z pliku zdarzenia; w innych zdarzeniach na `GITHUB_SHA`.
- **Bezpieczeństwo i sieć.** Token (wejście `github-token`, domyślnie `${{ github.token }}`) idzie tylko w nagłówku do `GITHUB_API_URL` (https), nigdy do logu. Odmowa (403/404: brak `checks: write`, token tylko do odczytu w PR z forka), brak odpowiedzi w 15 s czy brak zmiennych runnera dają jedną linię w logu i nie zatrzymują kroku. Wejścia kroku są zapisane przed wywołaniem API. Testy używają podstawionego `fetch`, bez sieci.
- **Repozytorium.** Zadanie „depcurfew on itself” ma `checks: write`; zadania z fiksturami mają `check-run: false`, żeby nie dodawać kilku wpisów o tej samej nazwie (a celowo zepsuta fikstura nie dawała czerwonego wpisu w PR). Przykład workflow w README nadaje `checks: write`.


## D-097 · `doctor --strict` i ostrzeżenie Node o `NO_COLOR` (2026-11-01)

- **Problem.** D-034: „ostrzeżenia nie powodują porażki; `--strict` można dodać później”. Zespół, który chce mieć repozytorium bez ostrzeżeń, nie miał jak tego wymusić w CI.
- **Decyzja.** `doctor --strict` (także z `--user`, `--json` i `--sarif`) kończy się kodem 1 także przy znalezisku `warning`. Noty (`note`, np. preset Renovate, którego nie da się przeczytać bez sieci) nigdy nie dają porażki, bo mówią, czego doctor nie umiał sprawdzić. Bez `--strict` znaczenie kodów wyjścia się nie zmienia.
  - Tekst przy ostrzeżeniach dopisuje pod licznikami linię `--strict: warnings count as failures, so depcurfew doctor exits with 1`, żeby kod wyjścia nie był zagadką. JSON ma nowe pole `strict` (`true`/`false`); `schemaVersion` zostaje 1. SARIF bez zmian.
  - `renderText` dostaje opcjonalny czwarty parametr `{ strict }` (zgodne wstecz).
  - Kody wyjścia opisuje `doctor --help` i README.
- **Ostrzeżenie Node przy `FORCE_COLOR` i `NO_COLOR` naraz (sprawdzone, występowało).** Node 22.15+ przy ładowaniu `node:util` (potrzebnego dla `parseArgs`) wypisuje na stderr „The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set”, więc `--json` nie miało pustego stderr. depcurfew decyduje o kolorach sam, tak samo (`colorsFor`: `FORCE_COLOR` wygrywa). Node emituje ostrzeżenia w następnym ticku; w Node 24 i 26 ten tick przychodzi jeszcze przed wykonaniem modułu, gdy `node:util` jest importem statycznym (CI na gałęzi to pokazało). Dlatego `src/cli.ts` najpierw instaluje filtr, a polecenia ładuje dynamicznym importem (`import('./cli/run.ts').then(...)`, bez top-level await); odfiltrowane jest tylko to jedno ostrzeżenie (i od D-103 ostrzeżenie o eksperymentalnym `fetch`), inne są wypisywane jak dotąd. Test e2e w `tests/e2e/bin.test.ts`.

## D-102 · Hook przed instalacją depcurfew, przypięcie wersji i granice narzędzia w README, uwaga o budowaniu Pythona w `init` (2026-11-01)

- **Skąd.** Ocena depcurfew 1.2.0 przez sesję Claude Code pracującą nad innym projektem (zespół z kilkoma niezależnymi katalogami, npm 10 w obrazach, backend w Pythonie). Wnioski, które dotyczą tej decyzji:
  - hook w zalecanej konfiguracji może zablokować sesję: wskazuje `node_modules/depcurfew` w korzeniu, a przy `onFailure: "block"` brak pliku blokuje każde polecenie powłoki, także `npm ci`, które miało go zainstalować;
  - domyślna polityka zabrania budowania paczek Pythona ze źródeł, więc paczka bez kół przestaje się instalować;
  - wydania są młode i częste, więc trzeba przypiąć dokładną wersję;
  - depcurfew nie blokuje znanego malware.
- **Fakty (sprawdzone 2026-11-01, nowy fakt `environment.claudeCode.sessionStart`).** Dokumentacja hooków (`hooks#block-the-action-when-a-hook-fails`): przy brakującym skrypcie i `onFailure: "block"` wywołanie jest blokowane („failed; blocking because onFailure is "block"”), bez tej opcji przechodzi. `SessionStart` z dopasowaniami `startup` i `resume`; „Claude's first response still waits for the hooks to finish”. W sesjach w chmurze (`cloud-environments#setup-scripts`) skrypt startowy działa przed uruchomieniem Claude Code, hooki z `.claude/settings.json` repozytorium działają, a te z `~/.claude` nie.
- **Decyzja: README (sekcja generowana z bazy wiedzy).** Akapit „Before depcurfew is installed”: co robi hook bez zainstalowanego depcurfew, instalacja przed sesją, hook `SessionStart`, który instaluje kopię z lockfile, gdy jej brakuje (`npm ci --ignore-scripts`, żeby przed strażnikiem nie działały skrypty zależności), repozytorium bez `package.json` w korzeniu (mały katalog narzędzi `.claude/depcurfew` z przypiętą wersją i lockfile), sesje w chmurze i co zrobić, gdy hook już blokuje. Kodu hooka nie zmieniamy: fail closed przy braku strażnika jest zamierzony, a wyjątek dla polecenia instalacji dałoby się obejść.
- **README: instalacja i granice.** `npm install --save-dev --save-exact depcurfew` z uzasadnieniem. Nowa sekcja „What depcurfew does not do”: brak bazy malware i skanowania treści paczek (złośliwa wersja starsza niż opóźnienie przejdzie), więc depcurfew łączy się z narzędziem blokującym znane malware i z audytem podatności; brak piaskownicy.
- **`init`.** Gdy wykrywa narzędzie Pythona (ekosystem z bazy wiedzy), dopisuje `note:`, że `installScripts.default: "deny"` blokuje też budowanie ze źródeł, i każe uruchomić `depcurfew doctor` przed `apply`, a zaufane paczki dopisać do `installScripts.allow` z prefiksem `pypi:`. Treść pliku polityki się nie zmienia.
- **Pozostałe wnioski z oceny** mają osobne decyzje: `projects` (D-100), npm z wersji Node i Dockerfile (D-099), serwer MCP dla innych agentów (D-096).
## D-096 · `depcurfew mcp`: serwer MCP dla innych agentów (2026-11-01)

- **Problem.** Hook (D-053, D-056) działa tylko w Claude Code. Agenci w Claude Desktop, VS Code (Copilot), Zed i innych klientach nie mieli jak zapytać depcurfew, czy paczkę wolno zainstalować; D-053 odłożyło MCP do czasu, aż protokół przejdzie na rewizję bez `initialize`.
- **Decyzja.** Nowe polecenie `depcurfew mcp [--dir] [--registry] [--index]`: serwer Model Context Protocol na stdio, JSON-RPC 2.0 napisany ręcznie (`src/mcp/`), bez SDK i bez nowej zależności.
- **Fakty** (`environment.mcp`, sprawdzone 2026-11-01): rewizje, nazwy metod, klucze `_meta`, kody błędów (-32700, -32600, -32601, -32602, -32603, -32022), ramki stdio, partie (tylko 2025-03-26) oraz konfiguracja klientów do README. Źródła przypięte do commitów: `modelcontextprotocol/modelcontextprotocol@d0e246ea` (specyfikacja, schemat i strony modelcontextprotocol.io, także „Connect to local MCP servers” dla Claude Desktop), `microsoft/vscode-docs@5a54a294` (`mcp-configuration.md`) i code.claude.com/docs/en/mcp. Nowe dozwolone lokalizacje w `ENVIRONMENT_SOURCES`: `modelcontextprotocol.io`, `github.com/modelcontextprotocol/`, `code.visualstudio.com`, `github.com/microsoft/vscode-docs/`. Cursor nie jest opisany: cursor.com był z tej sesji niedostępny, więc README mówi tylko, że inni klienci stdio biorą to samo polecenie.
- **Dwie ery naraz** (specyfikacja na to pozwala, `versioning.mdx`).
  - `initialize` otwiera sesję legacy na cały proces: wersja klienta, jeśli ją mamy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), inaczej 2025-11-25. Drugi `initialize` i `initialize` w partii to -32600. `ping` działa też przed `initialize`.
  - Żądanie z `io.modelcontextprotocol/protocolVersion` albo `clientCapabilities` w `params._meta` jest obsługiwane bezstanowo. Brak któregoś z nich to -32602, nieznana wersja to -32022 z `data: { supported, requested }`. Wyniki 2026-07-28 mają `resultType: "complete"` i `serverInfo` w `_meta`, a `server/discover` i `tools/list` także `ttlMs` (1 h) i `cacheScope: "public"`. W 2026-07-28 nie ma `ping` (-32601).
  - `supported` i `supportedVersions` wymieniają też wersje legacy, jak przykład w specyfikacji. Żądanie z wersją legacy w `_meta` jest więc obsługiwane bezstanowo, z wynikami tej wersji, żeby klient, który wybierze wersję z listy, nie dostał odmowy.
  - Żądanie bez `_meta` i bez sesji to -32602 z informacją, że trzeba wysłać `initialize` albo `_meta`.
  - Każda nieznana metoda dostaje -32601, nigdy ciszę, bo klienci dwóch er sprawdzają serwer przez `server/discover`.
- **Partie.** 2025-03-26 jest obsługiwane razem z partiami, zamiast podnosić tę wersję do 2025-11-25: klient, który zna tylko 2025-03-26 i 2024-11-05, rozłączyłby się po odpowiedzi 2025-11-25. Tablica JSON jest przyjmowana tylko w sesji, która wynegocjowała 2025-03-26, ma najwyżej 50 wiadomości, a odpowiedzi idą jedną tablicą (żadnej, gdy były same powiadomienia). W innych sesjach tablica to -32600.
- **Ramki i błędy JSON-RPC.** Identyfikator to tekst albo liczba całkowita; `null`, ułamek czy obiekt to -32600. Odpowiedź na błąd, którego identyfikatora nie da się odczytać, nie ma pola `id`, jak pozwalają schematy 2025-11-25 i 2026-07-28 (`null` z JSON-RPC 2.0 nie jest sprawdzony, bo jsonrpc.org był niedostępny). Powiadomienia nigdy nie dostają odpowiedzi, odpowiedzi klienta są pomijane (serwer nie wysyła żądań). Żądanie z identyfikatorem, który wciąż jest w toku, to -32600.
- **Narzędzia** (stała lista, stała kolejność, nazwy `^[a-z_]+$`):
  - `check_packages` (`packages`: 1 do 50 specyfikacji po najwyżej 1024 znaki, `directory?`): ten sam dokument co `check --json`. `src/cli/check.ts` ma teraz `checkDocument` (i `appliedPolicy`, `policyNotices`), z których korzystają CLI i serwer, więc znaleziska i komunikaty mają jedno źródło. Wynik to `structuredContent` i ten sam JSON w bloku tekstu; klient sprzed 2025-06-18 dostaje sam tekst, a 2024-11-05 narzędzia bez `title` i `annotations`. Paczka łamiąca politykę to udane sprawdzenie, nie `isError`. `isError` dostaje tylko wywołanie, które nie mogło się odbyć: polityka nie do użycia i nieistniejący katalog (z błędem z `errors`, jak w `check --json`), zły argument (pusta lista, ponad 50, nie tekst, nieznany argument, katalog poza projektem) z komunikatem, co zrobić, i zajęty serwer. Argumenty, które nie są obiektem, i nieznane narzędzie to -32602. Adnotacje: `readOnlyHint: true`, `openWorldHint: true`.
  - `explain_policy` (`directory?`): użyty `depcurfew.json` (albo `null` i domyślna polityka `init`), `cooldown` (minimum i wyjątki), `installScripts`, `sources`, rejestr, indeks i rejestry scope'ów z `.npmrc`, uwagi. `openWorldHint: false`.
  - Bez `outputSchema`: dokument opisuje README i `check --json`, druga definicja schematu musiałaby być utrzymywana osobno, a specyfikacja nie mówi, czy wynik z `isError` musi go spełniać.
- **Co dostaje model** (jak w hooku, D-061 i D-081). Każdy tekst dokumentu przechodzi przez `reasonText` z hooka (znaki sterujące i dwukierunkowe jako tekst, bez danych logowania w URL, najwyżej 400 znaków), skrypty instalacyjne są nazywane bez treści (`scriptBodies: false`), a `fix`, który zmienia `depcurfew.json` (`agentFix` w `src/check/hook.ts`, wspólne z hookiem), zastępuje „Choose another package or version. Only the user may change depcurfew.json: ask them instead of editing it.”; w `errors` zdanie, że politykę poprawia użytkownik. Limitu 4000 znaków na całość nie ma, bo ucięty JSON byłby nieczytelny; rozmiar ogranicza 50 paczek i 400 znaków na tekst. Opisy narzędzi i `instructions` są stałe i mówią wprost, że serwer doradza, a egzekwuje konfiguracja z `apply`.
- **Rejestr i katalog.** Rejestr i indeks nie są argumentami narzędzi: agent sterowany wstrzykniętym promptem mógłby wskazać własny rejestr, który poręczy za dowolną paczkę. Biorą się z `--registry`, `--index` i `.npmrc`, jak w `check`. Katalog projektu to `--dir`, potem `CLAUDE_PROJECT_DIR` (Claude Code ustawia go serwerowi), potem bieżący katalog; nieistniejący to błąd użycia (kod 2). `directory` w wywołaniu jest względne wobec katalogu projektu i musi w nim leżeć (porównanie po `realpath`, więc dowiązanie na zewnątrz też jest odrzucane): obcy katalog mógłby mieć `depcurfew.json`, który pozwala na wszystko. Politykę znajduje `findPolicyDirectory`, jak w `check` (D-078, D-079, D-081).
- **Odporność na złego klienta.** Linia ponad 1 MiB dostaje -32600 bez `id` i jest pomijana do końca bez buforowania. Zagnieżdżenie głębsze niż 64 poziomy jest liczone przed parsowaniem (-32600). Zły UTF-8 i zły JSON to -32700. CRLF i puste linie są w porządku, ostatnia linia bez znaku nowej linii też jest czytana. Najwyżej 4 wywołania narzędzi naraz i 16 w kolejce; kolejne dostaje wynik z `isError`, żeby spróbować później. Gdy klient nie czyta stdout, serwer przestaje czytać stdin do zdarzenia `drain`. Limity `check` bez zmian (15 s, 64 MiB, bez tokenów, prywatne rejestry niesprawdzone).
- **Wyjście i zakończenie.** Na stdout trafia tylko po jednym JSON w linii przez `safeJson` (bez surowych znaków nowej linii, C1 i bidi); diagnostyka idzie na stderr. EPIPE na stdout kończy serwer po cichu z kodem 0. Koniec stdin: wywołania w toku mają 1 s, potem są przerywane bez odpowiedzi. SIGINT i SIGTERM kończą od razu (Claude Code wysyła SIGINT, po 100 ms SIGTERM). `notifications/cancelled` przerywa wywołanie, także czekające w kolejce, przez `AbortSignal` aż do `fetch` (nowe `CheckOptions.signal`, `requestSignal` w `src/check/registry.ts`; `checkSpecs` odrzuca wtedy obietnicę) i tłumi jego odpowiedź.
- **CLI.** `mcp` w `src/cli/commands.ts` (opis, opcje, przykłady, kody wyjścia 0 i 2) i `src/cli/run.ts`; strumienie, środowisko i sygnały są wstrzykiwane (`CheckDependencies.mcpProcess`), więc testy prowadzą sesję w procesie (`tests/mcp/`), a `tests/e2e/mcp.test.ts` sprawdza zbudowany plik na prawdziwych potokach, zamknięty stdout oraz SIGINT i SIGTERM.
- **README.** Sekcja „MCP server” pod „Guarding installs”: narzędzia, co dostaje model, że serwer doradza, a egzekwuje konfiguracja z `apply`. Część z faktami (rewizje, `claude mcp add --scope project`, `.mcp.json` z `${CLAUDE_PROJECT_DIR:-.}`, Claude Desktop ze ścieżkami bezwzględnymi i `--dir`, `.vscode/mcp.json` z `cwd: ${workspaceFolder}`, `code --add-mcp`) generuje `src/docs/readme.ts` (`mcp-clients`). Każda konfiguracja uruchamia samo `node` ze ścieżką skryptu, bo na Windows `npx` to plik `.cmd`, którego klient bez powłoki nie uruchomi (jak w D-081 dla hooka).
- **Poza zakresem.** Zasoby, prompty, `listChanged`, `subscriptions/listen`, postęp, logowanie przez protokół, stronicowanie (każdy `cursor` to -32602) i transport HTTP. Sprawdzenie z prawdziwymi klientami (Claude Desktop, VS Code, Cursor) nie było możliwe w tej sesji.
- **`schemaVersion` zostaje 1.** Dokument `check_packages` to dokument `check --json`; `CheckOptions.signal` i nowe eksporty to zmiany zgodne wstecz.
- Przy okazji: `action/depcurfew.mjs` nie zawierał zmian z D-097 (`doctor --strict`); zbudowany na nowo.
## D-098 · „not applicable” w rozpisce kontroli (2026-11-01)

- **Problem.** Rozpiska kontroli z D-094 mówiła „passed” także o regułach, które projektu w ogóle nie dotyczą: reguły Pythona w projekcie bez narzędzi Pythona, `depcurfew-outdated` bez depcurfew w projekcie, reguły pnpm bez pnpm, reguły botów bez botów, reguły lockfile'ów bez lockfile'a. „13 checks: 13 passed” obiecywało więcej, niż doctor sprawdził.
- **Decyzja.** `RuleResult.result` ma nową wartość `not-applicable`. Reguła może mieć obok `check` małą funkcję `applies(project)` (`ProjectView` to `RuleContext` bez `report` i `notice`), która decyduje wyłącznie z wykrywania (`src/doctor/applies.ts`: `usesManager`, `usesBot`, `hasLockfile`), więc nie czyta plików, których reguły nie przeczytały. Brak `applies` znaczy, że reguła zawsze dotyczy projektu; w razie wątpliwości reguła dotyczy projektu.
  - `depcurfew-outdated`: kopia depcurfew w `node_modules` albo w `package-lock.json` (ta sama funkcja co `check`);
  - `manager-version-too-old`: jakikolwiek menedżer paczek (także Yarn Classic, o którym reguła mówi, że polityka go nie obejmuje); `setting-ignored-by-version`: wspierany menedżer paczek;
  - `npmrc-overrides-policy`: npm albo pnpm; `pnpm-shared-workspace-lockfile`: pnpm;
  - `python-config-ignored`: uv, pip, PDM albo Pipenv (narzędzia, które reguła sprawdza);
  - `bot-cooldown-mismatch`: bot i wspierany menedżer paczek; `broad-exclusion`: polityka, menedżer paczek albo bot;
  - `lockfile-forbidden-source` i `lockfile-install-scripts`: lockfile wspieranego menedżera paczek albo pliki requirements pip;
  - `invalid-policy`, `config-drift` i `unreadable-config` zawsze dotyczą projektu.
- **Znaleziska się nie zmieniają.** `check` biegnie jak dotąd, a reguła ze znaleziskiem ma zawsze `problems`, cokolwiek mówi `applies`. Test uruchamia każdą regułę bez `check` na jej fiksturach `fires-*` i pilnuje, że żadna nie jest tam „not applicable”.
- **Kolejność.** `problems` przed `not-applicable`, a `not-applicable` przed `skipped`: reguła, która potrzebuje polityki, ale projektu nie dotyczy (np. reguły lockfile'ów bez lockfile'a), nie dostałaby nic do sprawdzenia także z `depcurfew.json`, więc nie odsyła do niego.
- **Wyjście.** Tekst pisze „not applicable” (`resultText`, `checkedLines`, licznik „13 checks: 9 passed, 4 not applicable”), tak samo adnotacja `notice` czystego przebiegu, tabela „What was checked” podsumowania zadania i tytuł wpisu „depcurfew doctor”. JSON ma wartość `not-applicable`; `schemaVersion` zostaje 1 (nowa wartość, D-061). SARIF bez zmian.
- **`doctor --user`.** Bez żadnego narzędzia w PATH `user-config-drift`, `user-config-weakens` i `user-environment-overrides` są „not applicable” (pliki i zmienne są tych narzędzi), poza `user-config-drift`, gdy `targets` polityki użytkownika wymienia narzędzie z konfiguracją użytkownika (D-087: planowane bez PATH). `user-policy-invalid` i `user-config-unreadable` zawsze dotyczą.
- `ruleResults` dostaje opcjonalny czwarty parametr `applies` (zgodne wstecz).

## D-104 · Action: `fail-on`, adnotacje we wpisie „depcurfew doctor” i jeden wpis na commit (2026-11-01)

- **`fail-on` (część D-097).** Nowe wejście `fail-on: error | warning`, domyślnie `error`, więc nic się nie zmienia. Przy `warning` ostrzeżenia kończą krok błędem tak jak błędy, jak `doctor --strict`; noty nigdy. Inna wartość kończy krok błędem przed uruchomieniem doctor: „the input fail-on is "warnings"; set it to error (the default: errors fail the step) or warning (warnings fail it too)” (wyjście `failure`, wpis „depcurfew doctor” z `failure`).
  - `fail-on-error` zostaje i jest w opisie oznaczone jako przestarzałe. `fail-on-error: false` ma pierwszeństwo: krok nie kończy się błędem z powodu znalezisk, cokolwiek mówi `fail-on`.
  - O porażce decyduje teraz skrypt, nie wyrażenie w `action.yml`: wewnętrzne wyjście kroku `fail-reason` („depcurfew doctor reported 1 warning (fail-on: warning); the job summary and the log of the Run depcurfew doctor step say how to fix each one”), a ostatni krok („Fail on findings”) wypisuje je jako `::error` i kończy się kodem 1. Ten sam tekst w obu miejscach. Przy okazji krok i wpis Checks czytają `fail-on-error` tak samo (wyłącza tylko `false`, jak pozostałe przełączniki akcji); wcześniej `action.yml` porównywał z `'true'`, a skrypt z `'false'`.
  - Wniosek wpisu „depcurfew doctor”: `failure`, gdy znaleziska kończą krok błędem; `neutral` przy błędach lub ostrzeżeniach, które go nie kończą; w pozostałych przypadkach `success`. Przy `fail-on: warning` ostrzeżenia dają więc `failure`.
  - `action-test.yml` ma zadanie z fiksturą z jednym ostrzeżeniem i `fail-on: warning`, które musi się nie udać.
- **Adnotacje we wpisie.** Znaleziska trafiają do `output.annotations` wpisu (`checkRunAnnotations` w `src/doctor/github.ts`): `path`, `start_line` = `end_line` = linia znaleziska, `annotation_level` z poziomu (`error` -> `failure`, `warning` -> `warning`, `note` -> `notice`), `title` „depcurfew: <reguła>” (do 255 znaków), `message` z poprawką („Fix: …”, do 64000 bajtów, bo „64 KB” czytamy na niekorzyść).
  - Znalezisko bez linii (dotyczy całego pliku) dostaje linię 1 tego pliku, żeby było widać je przy pliku (wiadomość jest ta sama co w logu).
  - Pomijane są ścieżki spoza workspace'u, bezwzględne, z `..`, ze znakami sterującymi (po `printable` nie wskazywałyby pliku) i pliki, których nie ma (np. plik, który `apply` by utworzył; znalezisko jest wtedy przy `depcurfew.json`). Action nie uruchamia `doctor --user`, więc plików użytkownika tu nie ma.
  - Tekst przechodzi przez `printable` jak w innych adnotacjach; escapowanie poleceń przepływu pracy nie jest potrzebne, bo to JSON w treści żądania.
  - Limit: API przyjmuje 50 adnotacji na żądanie, a każda aktualizacja dopisuje kolejne. Wpis dostaje najwyżej 100 (`CHECK_RUN_ANNOTATIONS`, dwa żądania), błędy najpierw. Łączny limit wpisu nie jest udokumentowany, a zdanie „GitHub Actions are limited to 10 warning annotations and 10 error annotations per step” z opisu API nie mówi, czy dotyczy wpisów z API (niepewne), więc limit jest nasz i niewielki. Ile znalezisk nie ma adnotacji, mówi linia pod podsumowaniem wpisu; log ma wszystkie.
  - Nieudane dopisanie dalszych adnotacji to jedna linia w logu („…; 20 more annotations could not be added: the GitHub API answered HTTP 422”).
- **Jeden wpis na commit i nazwę.** Workflow na `push` i `pull_request` tego samego commita (wpis idzie na `pull_request.head.sha`, D-095) tworzył dwa wpisy. Przed utworzeniem akcja pyta o wpisy commita z tą nazwą (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs?check_name=…&filter=latest`; uprawnienie Checks read, które daje `checks: write`). Swój wpis rozpoznaje po `external_id: "depcurfew"`, który ustawia przy tworzeniu, i po nazwie; slug aplikacji tokenu workflow nie jest udokumentowany, więc na nim nie polegamy. Znaleziony wpis jest aktualizowany (`PATCH /repos/{owner}/{repo}/check-runs/{id}`: wniosek, tytuł, podsumowanie), a nie tworzony drugi.
  - Adnotacje są przy aktualizacji dopisywane i nie da się ich usunąć, więc wpis, który już je ma (`output.annotations_count` > 0), je zachowuje; ten sam commit daje te same znaleziska. Wpis bez adnotacji dostaje je przy aktualizacji.
  - Nie jest to atomowe: dwa zadania działające w tej samej chwili mogą oba nie znaleźć wpisu i dodać po jednym. GitHub nie ma operacji „znajdź albo utwórz”, a `concurrency` workflow to decyzja użytkownika.
  - Każdy błąd wyszukiwania lub aktualizacji (odmowa, brak odpowiedzi, wpis innej aplikacji z tym samym `external_id`) kończy się utworzeniem wpisu jak dotąd; każdy błąd tworzenia to jak dotąd jedna linia w logu i nigdy porażka kroku. Każde żądanie ma 15 s, najwyżej cztery żądania (wyszukanie, utworzenie lub aktualizacja, jedno dopisanie adnotacji, ewentualnie utworzenie po nieudanej aktualizacji).
  - Wpisy z wcześniejszych wersji akcji nie mają `external_id`, więc pierwszy przebieg nowej wersji doda obok nich własny.
- **Baza wiedzy.** `environment.githubActions.checkRuns` ma ścieżki `endpoints` (create, update, list), parametry `query`, `annotationsPerRequest` (50), `annotationLevels`, limity tytułu i wiadomości adnotacji oraz notatkę o tym, czego dokumentacja nie mówi. Źródło: `https://docs.github.com/en/rest/checks/runs` (czytane z github/rest-api-description i github/docs, z commitami w notatce), `verifiedAt` 2026-11-01. `CheckRunFetch` zwraca też `json()`.
## D-100 · `projects`: kilka niezależnych projektów w jednym repozytorium (2026-11-01)

- **Problem.** Repozytorium bywa zbiorem niezależnych projektów: `frontend/`, `backend/`, `shared/`, `deck/`, każdy z własnym `package.json` albo `pyproject.toml` i lockfile'em, często bez manifestu w katalogu głównym, a konfiguracja Dependabota lub Renovate leży w katalogu głównym. Dotąd trzeba było uruchamiać depcurfew osobno w każdym katalogu, a boty z katalogu głównego, więc opóźnienie botów nie znało menedżerów projektów.
- **Decyzja (właściciela): lista w polityce.** Nowe opcjonalne pole `projects`, domyślnie `[]`, w `src/policy/schema.ts` (walidator, typy i `schema.json` z jednego źródła, D-016). Polityka zostaje `version: 1`.
  - Wpis to katalog względem katalogu głównego z `/` między katalogami (`src/policy/project-directory.ts`, ten sam wzorzec w JSON Schema i test zgodności na przykładach). Odrzucane z komunikatem, co wpisać: pusty wpis, `.`, ścieżka absolutna i litera dysku, `\`, `/` na końcu (bez normalizacji, bo schemat ma przyjmować dokładnie postać kanoniczną), `//`, segmenty `.` i `..`, wzorce i znaki `: * ? " < > |`, `node_modules` i `.git`, powtórzenia.
  - Projekt w projekcie (`frontend` i `frontend/app`) jest błędem: każdy katalog jest planowany osobno, więc pliki wewnętrznego byłyby planowane dwa razy. Dwa wpisy różniące się tylko wielkością liter też, bo na Windows i macOS to ten sam katalog. Oba sprawdza walidator (poza schematem, jak inne reguły kilku pól).
  - Polityka użytkownika (`--user`) z `projects` jest błędna: konfiguruje narzędzia komputera, nie repozytorium.
- **`apply`** (`planRepository` w `src/apply/index.ts`, `applyProject` korzysta z niego):
  - katalog główny jest planowany jak dotąd; każdy wpisany katalog jak osobny projekt z polityką katalogu głównego (wykrywanie z nim jako korzeniem: własne `.npmrc`, lockfile'e, workspace'y);
  - Renovate i Dependabot tylko z katalogu głównego, bo stamtąd czytają konfigurację (pliki z bazy wiedzy to ścieżki od katalogu głównego). `botDuration` bierze minuty menedżerów wszystkich projektów, a reguła Renovate dla Pythona patrzy na narzędzia wszystkich projektów. W fiksturze `multi-project` npm w `frontend` zaokrągla `36h` do 2 dni, więc oba wpisy Dependabota dostają `default-days: 2`;
  - wszystkie zmiany idą jednym `writeChanges` od katalogu głównego, więc wszystko albo nic dla całego repozytorium;
  - każda ścieżka (zmiany, ostrzeżenia, błędy, fragmenty, JSON) jest względna do katalogu głównego. Generatory pracują na ścieżkach projektu, a `relocateText` (`src/apply/projects.ts`) zamienia w treści komunikatów całe ścieżki plików projektu (z wykrywania, planu i położeń) na `frontend/…`; `depcurfew.json` zostaje, bo to polityka katalogu głównego. Ostrzeżenie projektu ma nowe pole `project`, a komunikat bez pliku zaczyna się od nazwy katalogu (`backend: uv has no setting …`);
  - `.gitignore` dla plików projektów czyta katalog główny (`file-ignored-by-git`), bo reguły katalogu głównego obejmują też projekty;
  - nowe błędy w `APPLY_ERRORS`: `project-not-found`, `project-not-a-directory`, `project-symlink` (katalog albo katalog po drodze jest symlinkiem, także prowadzącym poza repozytorium; depcurfew nie idzie za symlinkiem, więc zapis zostaje w repozytorium), `project-has-policy` (dwie polityki dla tych samych plików; poprawka: usuń plik albo wpis) i `project-in-workspace`. Ten ostatni to błąd, nie ostrzeżenie: katalog będący pakietem workspace'u katalogu głównego (albo go zawierający lub w nim leżący) konfiguruje już katalog główny, a dwa plany tych samych plików to dokładnie konfiguracja, która nie robi tego, co się wydaje. Położenie to linia wpisu w `depcurfew.json` (przy `project-has-policy` plik projektu). Pozostałe katalogi są i tak planowane, żeby jeden przebieg zgłosił wszystko, ale nic nie jest zapisywane. Błędy mają w `ApplyReport` pole `problems` (wspólny typ `ApplyProblem` z `apply --user`);
  - katalog główny z projektami może nie mieć żadnego menedżera, więc nie dostaje `nothing-to-configure`; dostaje je wpisany katalog, w którym nic nie znaleziono. `tool-only-in-ci` nie pada dla narzędzia, które konfiguruje któryś projekt, bo workflowy katalogu głównego instalują projekty;
  - przy jawnej liście `targets` z projektami menedżer z listy jest konfigurowany tylko w katalogach, które go używają (`directoryTargets` w `src/apply/targets.ts`), bo inaczej projekt Pythona dostałby `.npmrc`. Menedżer, którego nie używa żaden katalog, daje nowe ostrzeżenie `target-not-found`. Bez `projects` znaczenie `targets` się nie zmienia.
- **`doctor`** (`runDoctor`): reguły biegną na katalogu głównym i na każdym projekcie z polityką katalogu głównego. Nowa opcja `policy` podaje politykę zamiast czytać plik (`null`: jak bez polityki).
  - `RuleContext` dostał `project` (reguły biegną na projekcie), `projects` (na katalogu głównym: widoki projektów) i `plan` (opcje planu dla `config-drift`). `bot-cooldown-mismatch` i `broad-exclusion` porównują boty z menedżerami wszystkich projektów przez `managerSources` (`src/doctor/projects.ts`); menedżer projektu występuje w komunikacie jako `npm in web`, a plik jego opóźnienia jako `web/.npmrc`. Polityki w projekcie nie ma, więc `broad-exclusion` nie sprawdza jej tam drugi raz.
  - Znaleziska i uwagi projektów mają przedrostek ścieżki, są sortowane jak dotąd; `checked.tools` mają pole `project`, przeczytane pliki są z przedrostkiem, a każda reguła występuje raz z wynikiem liczonym ze znalezisk wszystkich katalogów.
  - Nowa reguła `invalid-project` (error, wymaga polityki) zgłasza te same problemy co `apply`, z tym samym komunikatem i poprawką; doctor sprawdza wtedy pozostałe katalogi zamiast przerywać. SARIF, `--json`, tekst i Action (przez `runDoctor`) działają bez zmian w ich kodzie.
- **`explain`:** opisuje katalog główny i każdy projekt; JSON ma nowe pole `projects` (`directory`, `project` z wykrywaniem o ścieżkach od katalogu głównego i `targets`, albo `project: null` z `error`), zawsze obecne, puste bez projektów. `cooldown.tools` obejmuje narzędzia wszystkich katalogów. `schemaVersion` zostaje 1.
- **`init`:** gdy katalog główny nie ma manifestu ani lockfile'a żadnego narzędzia (nazwy z bazy wiedzy przez `detectionFacts`), a bezpośrednie podkatalogi (bez `node_modules`, `.git` i katalogów z kropką, bez symlinków) mają, zapisuje je posortowane w `projects` i mówi o tym. Najdłuższe opóźnienie z D-075 obejmuje też projekty (komunikat podaje plik od katalogu głównego). Z manifestem w katalogu głównym nic się nie zmienia.
- **`check` i hook** bez zmian: `findPolicyDirectory` z katalogu projektu znajduje politykę katalogu głównego repozytorium (test), a polityka z `projects` jest dla nich poprawna. Ograniczenie: `check` czyta `.npmrc` (rejestr) katalogu z polityką, nie projektu.
- **Ograniczenia.** Kroki CI w `.github/workflows` katalogu głównego należą do wykrywania katalogu głównego, więc wersje menedżerów z `actions/setup-*` nie są przypisywane projektom. Wpisy Dependabota są porównywane z menedżerami wszystkich projektów tego ekosystemu, bez patrzenia na `directory`. Konfiguracja bota w katalogu projektu nie jest edytowana ani zgłaszana jako nieczytana przez bota, bo baza wiedzy nie ma jeszcze faktu o tym, skąd boty jej nie czytają (dokumentacji nie dało się sprawdzić bez sieci).
- **Zgodność wstecz.** Bez `projects` wszystko działa jak dotąd. Nowe pola (`projects` w polityce, `explain --json` i `checked.tools`, `project` w ostrzeżeniach `apply --json`), nowe kody i nowa reguła, bez zmiany `schemaVersion`. `ResolvedPolicy` ma zawsze `projects`. Publiczne API: `planRepository` i typy `ApplyProblem`, `PlanOptions`, `ProjectProblem`.
- **Testy:** fikstura `multi-project` (przed i po, idempotencja, `doctor` po `apply`), fikstury polityk `bad-projects`, `projects-overlap`, `projects-listed`, fikstury `doctor` `invalid-project/*`, `bot-cooldown-mismatch/fires-project`, `config-drift/fires-in-project` oraz `tests/projects.test.ts` (błędy katalogów, symlinki, workspace, jawne `targets`, doctor, explain, init, polityka użytkownika).
## D-101 · `--user` po 1.2.0: opóźnienie w `init --user`, wersje Yarn i Bun z plików, Poetry i PDM na macOS, Deno (2026-11-01)

- **Problem.** D-087 zostawiło poza zakresem 1.2.0 trzy rzeczy: `init --user` nie przenosił dłuższego opóźnienia z istniejących plików użytkownika, więc `apply --user` je skracał (z ostrzeżeniem `cooldown-shortened`, ale polityka zaczynała od `3d`); wersje Yarn i Bun zainstalowanych bez paczki npm o nazwie narzędzia były nieznane; ścieżka Poetry i PDM na macOS była zapisana jako sporna. Do tego przeliczenie Deno `Math.ceil(minutes / 1440)` siedziało w `src/user/generators.ts`, a nie w bazie wiedzy.
- **`init --user` zachowuje dłuższe opóźnienie.** `src/user/delays.ts` czyta klucze opóźnienia (`user.settings`, cel `cooldown`, dla wersji w użyciu) z pliku, który pisze `apply --user`, czytnikiem `doctor --user` (`parseUserFile`, `readsSection`; w INI ostatnia linia klucza, wartość przez `iniValue`), dla narzędzi z `PATH` jak przy `targets: "auto"`. Najdłuższe opóźnienie dłuższe od domyślnego staje się `cooldown.minimum`, zaokrąglone w górę do pełnych minut (`longestOf` i `policyDuration`, wspólne z `init` w projekcie), a komunikat jest ten sam co w projekcie: ustawienie, wartość, plik (`~/.npmrc`) i linia. Wartość w bloku depcurfew też się liczy (`init --user --force` po `apply --user` z dłuższą polityką jej nie traci), data zamiast czasu trwania nie. Plik, którego nie da się przeczytać, nic nie wnosi; zgłaszają go `apply --user` i `doctor --user`.
- **Deno: jednostka w bazie wiedzy.** Nowe pole `user.cooldownUnit` (`UserCooldownUnit`: klucz, jednostka, tylko liczby całkowite, co z innymi wartościami): Deno czyta `min-release-age` z `~/.npmrc` w pełnych dniach, a inne wartości (`72h`, `1.5`) pomija bez słowa; `deno.json` i `--min-dep-age` biorą minuty (`libs/npmrc/lib.rs` w v2.9.8). Generator bierze z faktu jednostkę i zaokrąglenie w górę (`userCooldownAmount`), a `cooldown-shortened` i `init --user` przeliczają starą wartość przez `userDelayMinutes`. Zaokrąglenie w górę wynika z zasady projektu (zawsze dłuższe opóźnienie), fakt mówi tylko, że liczą się pełne dni.
- **Yarn z `@yarnpkg/cli-dist`.** `environment.corepack.toolPackages` (z `config.json` Corepacka 0.36.0) wymienia paczki npm, z których instaluje się narzędzie; `@yarnpkg/cli-dist` (Yarn 2+, `bin.yarn` i wersja w `package.json`) liczy się jako paczka Yarna. To odwraca zdanie z D-089 („Yarn Berry zainstalowany jako `@yarnpkg/cli-dist` też nieznany”).
- **Shimy Corepacka.** Gdy `package.json` za plikiem wykonywalnym to paczka `corepack` (`environment.corepack.package`), wersją jest wpis narzędzia w `lastKnownGood.json`, który Corepack uruchamia poza projektem (fakt `environment.corepack.defaults`, od Corepacka 0.13.0), bez hasha po `+`. Katalog jest sporny: kod (`sources/folderUtils.ts`) sprawdza `COREPACK_HOME`, `XDG_CACHE_HOME`, `LOCALAPPDATA` (na każdym systemie) i dopiero katalog domowy, a README pomija `XDG_CACHE_HOME`; depcurfew idzie za kodem, bo to on działa. Zmienna ustawiona, choć pusta, liczy się jak w kodzie (`??`), więc pusta lub względna daje wersję nieznaną (nowe pole `UserDirectory.from.emptyCounts`). Bez pliku albo bez wpisu Corepack pobiera najnowszą wersję z npm (dla Yarna to Classic) i wersja zostaje nieznana jak dotąd. To samo działa dla shimu pnpm.
- **`yarnPath` w `~/.yarnrc.yml` (decyzja: użyć, ostrożnie).** Yarn 2+ czyta `yarnPath` także z pliku domowego i uruchamia wskazany plik zamiast siebie, więc wersja w użyciu to wersja tego pliku. Wersji w paczce nie da się pewnie odczytać (kod jest zminifikowany), a nazwa pliku jest tylko wskazówką (fakt `yarn.extra.yarnPath`, `uncertain`). depcurfew używa jej tylko, gdy nazwa to `yarn-<dokładna wersja>.cjs` (tak nazywa plik `yarn set version`), plik istnieje, wartość nie ma `${...}`, nie jest ustawione `YARN_YARN_PATH` ani `YARN_IGNORE_PATH` (w dowolnej wielkości liter), a globalny Yarn nie jest Classic (1.x nie czyta `.yarnrc.yml`). `doctor --user` pisze w `checked.tools[].versionFrom` „yarnPath in ~/.yarnrc.yml”, a dla Corepacka ścieżkę `lastKnownGood.json` (nowe pole `InstalledVersion.from`).
- **Bun.** Paczka npm `bun` już działała (postinstall zostawia `bin/bun.exe`, test na tym układzie). Oficjalny instalator zapisuje tylko `~/.bun/bin/bun` bez pliku z wersją, więc wersja zostaje nieznana i trzeba `--for` (README). Ścieżka `Cellar/bun/<wersja>` Homebrew wynika z ogólnej konwencji Homebrew, której nie opisuje źródło z naszej listy (formuła `oven-sh/homebrew-bun` mówi tylko `bin.install "bun"`), więc jej nie czytamy. Wersji wpisanej w plik binarny (ok. 100 MB) też nie szukamy.
- **Poetry i PDM na macOS.** Oba narzędzia wołają `platformdirs.user_config_path` bez nadpisania, więc katalog zależy od zainstalowanego platformdirs, nie od wersji narzędzia. Fakt `user.libraryDirectories` (źródło `tox-dev/platformdirs` 4.14.2 `docs/changelog.rst`, kod przy tagach w notatce; `github.com/tox-dev/` doszło do dozwolonych źródeł Poetry i PDM z komentarzem): przed 4.6.0 zawsze `~/Library/Application Support/<app>`; 4.6.0-4.9.5 niepuste `XDG_CONFIG_HOME` (także względne, czytane z bieżącego katalogu), inaczej niepuste `XDG_DATA_HOME`; 4.9.6-4.11.7 tylko `XDG_CONFIG_HOME`; od 4.11.8 tylko bezwzględne `XDG_CONFIG_HOME`. `user.files` jest teraz `verified` z dokumentacji (macOS: Application Support), a dawny spór znika.
  - Wersję platformdirs czyta `libraryVersion` z `platformdirs-*.dist-info/METADATA` w tym samym `site-packages`, co `.dist-info` narzędzia; `userFileFor` dostaje ją jako trzeci argument, a `src/user/user-file.ts` łączy to dla `apply --user`, `doctor --user` i `init --user`.
  - Gdy wersji nie da się odczytać, a zmienne dają różne pliki, `apply --user` pisze tam, gdzie mówi dokumentacja, i ostrzega nowym kodem `user-file-uncertain`: oba pliki z zakresami wersji platformdirs, poprawka każe sprawdzić folder `platformdirs-<wersja>.dist-info` obok narzędzia albo usunąć zmienne, które przesuwają plik. Polecenia Poetry i PDM, które pokazałoby ścieżkę, dokumentacja nie opisuje, więc poprawka go nie podaje. `doctor --user` pokazuje to ostrzeżenie jako notatkę i sprawdza wszystkie pliki, które narzędzie może czytać. Bez tych zmiennych ostrzeżenia nie ma, bo każda wersja daje ten sam plik.
  - Tabela w README pokazuje zakresy platformdirs, a katalog z `absolute: true` dostaje dopisek „(when it is an absolute path)” (dotyczy też npm, Bun i uv, co było prawdą i wcześniej).
- **Yarn `npmScopes`.** Sprawdzone testem: `doctor --user` dla `npmScopes: { acme: { npmMinimalAgeGate: 0 } }` nazywa `npmScopes.acme.npmMinimalAgeGate` w komunikacie i poprawce (ścieżka wpisu z pliku, nie wzorzec z bazy wiedzy). Zmiana kodu nie była potrzebna.
- **Otwarte.** Linux: Poetry i PDM też pytają platformdirs, więc względne `XDG_CONFIG_HOME` przed 4.11.8 to plik z bieżącego katalogu, a od 4.11.8 `~/.config`; baza wiedzy dalej mówi „nie wiadomo” (`user-directory-relative`). `YARN_YARN_PATH` ustawione w środowisku nie daje wersji (tylko wyłącza wskazówkę z pliku). Komunikat `doctor --user` dla Yarna ma podwójny nawias „(Yarn (Berry))”.
- **Zgodność wstecz.** Nowy kod ostrzeżenia `user-file-uncertain`, nowe wartości `versionFrom`, nowe pola bazy wiedzy (`libraryDirectories`, `cooldownUnit`, `emptyCounts`, `corepack.package`, `corepack.toolPackages`, `corepack.defaults`, `yarn.extra.yarnPath`); `schemaVersion` bez zmian.

## D-103 · CLI działa od Node 18.3.0 (2026-11-01)

- **Skąd.** Właściciel: wspieramy „najmniejsze wersje wspierające nasze rozwiązania”. Ocena innej sesji: zespół ma Node 20 w obrazach, a hook z `onFailure: "block"` na komputerze, na którym depcurfew się nie uruchamia, blokuje każde polecenie.
- **Jak ustalone.** Pobranych binariów Node nie wolno było tu uruchomić (klasyfikator), więc najniższą wersję ustaliło CI: nowe zadanie `runtime` w `ci.yml` buduje CLI na Node 24 i uruchamia na każdej wersji z macierzy próbę dymną `tests/runtime/smoke.mjs` (czysty JavaScript, bo starsze Node nie uruchamiają `.ts`): pomoc, `explain`, `doctor` z SARIF, `init`, `apply` dwa razy, `doctor` po `apply`, hook (polecenie bez instalacji, zły JSON, wymyślona nazwa), `init --user`, `doctor --user`, `check` przez lokalny rejestr na 127.0.0.1 z nagranymi odpowiedziami (bez sieci zewnętrznej) i sesję `mcp`. Każdy krok ma oczekiwany kod wyjścia i pusty stderr tam, gdzie obiecujemy pusty. Vitest uruchamia tę samą próbę na bieżącym Node (`tests/runtime/smoke.test.ts`).
- **Wyniki (przebiegi CI 41292215873, 41293060399, 41293847799):** Node 16.20.2 - wszystko poza `check` (brak globalnego `fetch`); 18.0.0 - nic (`parseArgs` jest od 18.3.0); 18.3.0 i 18.12.0 - wszystko, ale `check` wypisuje na stderr „ExperimentalWarning: The Fetch API is an experimental feature”; 18.17.0, 18.20.8, 20.0.0, 20.x, 22.0.0 i 22.x - wszystko.
- **Decyzja.** `engines.node` to `>=18.3.0` (zastępuje `>=22` z D-005). `src/cli.ts` odfiltrowuje ostrzeżenie o eksperymentalnym `fetch`, tak jak ostrzeżenie NO_COLOR (D-097): `fetch` działa tak samo, a ostrzeżenie psułoby pusty stderr `--json`. Macierz `runtime` (18.3.0, 18, 20.0.0, 20, 22.0.0, 22) jest teraz stała, a test w `tests/meta/ci.test.ts` pilnuje, że zawiera najniższą wersję z `engines`.
- **Bez zmian.** Praca nad repozytorium nadal wymaga Node 22.18 (tsdown, type stripping skryptów), testy Vitest działają na Node 22, 24 i 26, `@types/node` zostaje w wersji 22 (to typy, nie wymaganie), a Action uruchamia własny bundel na Node 22. README mówi, że Node 18 i 20 nie dostają już poprawek bezpieczeństwa.
- **Ryzyko resztkowe.** Próba dymna obejmuje główne ścieżki, nie każdą funkcję; nowe API Node spoza Node 18.3 wyjdzie w zadaniu `runtime`, jeśli trafi na ścieżkę próby. Przy dodawaniu kodu warto sprawdzać sekcje `added:` dokumentacji Node.
- **Ostrzeżenie Node przy `FORCE_COLOR` i `NO_COLOR` naraz (sprawdzone, występowało).** Node 22.15+ przy ładowaniu `node:util` (potrzebnego dla `parseArgs`) wypisuje na stderr „The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set”, więc `--json` nie miało pustego stderr. depcurfew decyduje o kolorach sam, tak samo (`colorsFor`: `FORCE_COLOR` wygrywa). Node emituje ostrzeżenia w następnym ticku, po importach, więc `src/cli.ts` odfiltrowuje tylko to jedno ostrzeżenie; inne są wypisywane jak dotąd. Test e2e w `tests/e2e/bin.test.ts`.

## D-099 · npm z wersji Node, pliki wersji Node i Dockerfile (2026-11-01)

- **Problem.** Zespół pracuje na npm 10 (obrazy Node 20 i 22), a depcurfew przy nieprzypiętym npm po cichu zakładał npm 12. Node 22 LTS (wsparcie do 2027-04-30) ma npm 10.9.x, który nie zna `min-release-age` i bez słowa pomija nieznane klucze `.npmrc`, więc opóźnienie zapisane przez `apply` nic tam nie robi. Node 24 dostaje npm 11.10 lub nowszy dopiero od 24.14.1, a Node 25 nigdy nie dostał npm 11.16 (`strict-allow-scripts`). Wykrywanie zbierało wersje Node (devEngines, Volta, `.tool-versions`, setup-node), ale żadna reguła z nich nie korzystała, a `doctor` nie czytał Dockerfile'ów. Kierunek właściciela: obsługiwać projekty aż do najniższych wersji, które mają ustawienia, i mówić dokładnie, czego brakuje i jak to naprawić.
- **Wiedza** (sprawdzona 2026-11-01, źródła przypięte do commitów):
  - `environment.node.bundledNpm`: npm każdego wydania Node od 18.0.0 z `nodejs.org/dist/index.json`, zwięźle: dla każdej linii pierwsze wydanie z danym npm i najnowsze znane wydanie (sha256 pliku w notatce). Bez wydań wstępnych (27.0.0-alpha z npm 12.1.0).
  - `environment.node.releaseSchedule`: daty linii 4-27 z `schedule.json` w nodejs/Release, nazwy kodowe małymi literami.
  - `environment.node.nvmrc`, `nodeVersionFile`, `engines`: format `.nvmrc` (nvm), `.node-version` (nodenv, fnm z `v`), `engines.node` jako zakres doradczy (npm).
  - `githubActions.setupNodeVersions` i `setupNodeVersionFile`: nazwy (`lts/*`, `lts/<nazwa>`, `lts/-n`, `latest`, `current`, `node`, `*`) i sposób czytania `node-version-file` przez setup-node v7.1.0 (kolejność `volta.node`, `devEngines.runtime`, `engines.node`; wzorzec tekstowy z `src/util.ts`).
  - `docker.*`: nazwy obrazów (`docker.io`, `index.docker.io`, przestrzeń `library`, domyślny tag `latest`; moby/moby, docker/cli), składnia Dockerfile (moby/buildkit), nazwy plików (`Dockerfile`, `*.Dockerfile`, niepewne `Dockerfile.<nazwa>`, `Containerfile` z Buildah). Obraz `node` ma npm z tarballa bez zmian (nodejs/docker-node), obraz `python` ma pip z ensurepip CPythona (docker-library/python), tagi i warianty z docker-library/official-images.
  - `python.bundledPip`: `_PIP_VERSION` z `Lib/ensurepip/__init__.py` dla każdego wydania 3.9.0-3.15.2, zwięźle jak dla Node.
  - npm: `extra.installCommands` (aliasy `install`, `ci`, `install-ci-test`, `update` z `cmd-list.js`), `extra.globalOption` (`--global`, `-g`, `--location=global`), `extra.unknownConfigKeys` (npm 10 pomija nieznane klucze bez ostrzeżenia, ostrzeżenie od 11.2.0, ustalone z kodu). Corepack: `enableNpm` (`corepack enable` bez nazwy nie podmienia npm).
  - Nowe dozwolone źródła środowiska: `github.com/docker-library/`, `/moby/`, `/docker/`, `/containers/`, `/nvm-sh/`, `/nodenv/`, `/schniz/`.
- **Wykrywanie.**
  - Nowe źródła wersji Node: `.nvmrc` (pierwsza linia bez komentarza `#`), `.node-version`, `engines.node` (zakres, jak zapisano) i Dockerfile (`FROM node:<tag>`). `VersionSource` ma nowe wartości `nvmrc`, `node-version`, `engines`, `dockerfile`.
  - setup-node: `node-version-file` wskazujący plik, który depcurfew umie przeczytać tak jak setup-node, daje także `version` (obok `versionFile`). `${{ matrix.<klucz> }}` rozwija się do wartości listy macierzy i `include` (każda wartość z własną linią i polem `matrix`). Deklaracje z workflow mają pole `job`.
  - Nowe pola wykrywania: `jobs` (zadania workflow z poleceniami: instalacja przez npm lub pip, podmiana npm lub pip, `runsNode`) i `dockerfiles` (etapy z obrazem po podstawieniu ARG, etapem bazowym, obrazem `node` lub `python` z wersją z tagu i poleceniami RUN). `explain` pokazuje je w tekście i w `--json`.
  - Dockerfile: w korzeniu, w bezpośrednich podkatalogach bez własnego manifestu (np. `docker/`, `.devcontainer/`) i w pakietach workspace'u; bez `node_modules` i `.git`; limit 1 MiB jak w całym wykrywaniu. Czytnik jest liniowy i bez rekurencji: dyrektywy (`# escape=`), komentarze także wewnątrz kontynuacji, kontynuacja linii, instrukcje dowolną wielkością liter, `FROM [--platform=..] obraz[:tag][@digest] [AS nazwa]`, ARG przed pierwszym FROM z `$VAR`, `${VAR}`, `${VAR:-x}`, `${VAR-x}`, `${VAR:+x}`, `${VAR+x}`, etapy dziedziczące obraz, RUN w formie powłoki, JSON (exec) i here-documenty podane powłoce (`RUN <<EOF`, `RUN bash <<EOF`); dane here-documentów (np. `cat <<EOF > plik`) nie są czytane jako polecenia.
  - Tagi: `22`, `22.11`, `22.11.0` z wariantem, `lts`, `lts-<nazwa>`, nazwy kodowe, `current`, `latest`, sam wariant (`alpine`). Ruchome tagi oznaczają linię z bazy wiedzy (niepewne). Sam digest, ARG bez wartości albo nieznany tag: wersja nieznana i uwaga w `doctor`.
  - Polecenia w RUN i krokach `run` czyta mały, liniowy czytnik w `src/detect/commands.ts` (cudzysłowy, `;`, `&&`, `||`, `|`, nawiasy, `sudo`, `env`, przypisania, `sh -c`) z faktami z bazy. Skaner `check` (`src/check/command.ts`) się do tego nie nadaje: zgłasza tylko paczki z nazwą, a nie `npm ci` ani `npm install` bez argumentów. Podmiana npm w Dockerfile (`npm install -g npm@X`) i pip (`pip install pip==X`) to nowe deklaracje wersji menedżera (`source: dockerfile`). Ten czytnik zastąpił wyrażenie regularne `npm install -g npm@` z D-025; `echo "npm i -g npm@1"` nie jest już podmianą npm.
- **`manager-version-too-old`: npm z wersji Node** (w tej samej regule, bo to „zadeklarowana wersja menedżera”; zdanie `checks` uzupełnione):
  - Miejsca, które decydują o Node: zadanie CI, które instaluje przez npm, a przed pierwszą instalacją nie podmienia npm; etap Dockerfile, który instaluje przez npm bez podmiany npm w nim ani w etapach, od których zaczyna; pliki programistów `.nvmrc`, `.node-version`, Volta `node` (pomijana, gdy Volta przypina też npm), `.tool-versions` `nodejs`, `devEngines.runtime` i `engines.node`.
  - Deklaracja wyznacza zbiór wydań Node: dokładna wersja jedno wydanie, zakres (`24`, `>=22`, `lts/*`, `node:24`) wszystkie znane pasujące wydania, bo setup-node bierze najpierw wersję z pamięci podręcznej runnera, a obraz z tagiem `24` może być starszy. Z niego wynika zbiór npm, sprawdzany względem tej samej listy ustawień co dotąd (polityka i ustawienia już zapisane).
  - Poziom: `error`, gdy żaden npm z tego zbioru nie ma ustawienia, w CI i Dockerfile; `warning`, gdy brakuje go tylko części, i zawsze dla plików programistów (każdy może sam zainstalować nowszy npm).
  - Komunikat podaje wersję Node, plik i linię (dla macierzy linię wartości), wersje npm, brakujące ustawienia z wersjami, w których się pojawiły, linię instalacji i to, że npm przed 11.2.0 pomija nieznane ustawienia bez ostrzeżenia. Poprawka: `npm install -g npm@X` przed instalacją w tym zadaniu lub etapie (X to wersja z `packageManager`, `devEngines`, Volty lub `.tool-versions`, gdy wystarcza, a w przeciwnym razie najniższa potrzebna) albo pierwsze wydania wspieranych linii LTS z takim npm (dla npm 11.10.0: 24.14.1 lub późniejsze 24.x; 26.0.0 lub późniejsze).
  - pip: etap Dockerfile z oficjalnym obrazem `python`, który uruchamia `pip install` bez wcześniejszej podmiany pip, gdy pip jest wykrytym menedżerem, a polityka wymaga ustawień pip (opóźnienie od pip 26.1.0). Poprawka: `pip install pip==X` albo pierwsze wydania CPythona z takim pip (3.13.14, 3.14.5, 3.15.0).
- **`runtime-end-of-life`** (nowa reguła, `warning`, bez polityki): wersja Node, która dopuszcza wyłącznie linie po końcu wsparcia, gdziekolwiek zadeklarowana. Komunikat podaje linię i datę, poprawka wspierane linie LTS z datami końca. Zakres, który dopuszcza też wspieraną linię (`engines: >=18`), nie jest zgłaszany.
- **Heurystyki depcurfew (to nie są fakty o narzędziach):**
  - `engines.node` liczy się tylko w paczce z `"private": true` i tylko wtedy, gdy żaden inny plik programistów nie wskazuje Node. W publikowanej paczce opisuje Node jej użytkowników, a npm traktuje to pole jako doradcze (to repozytorium ma `>=22` dla użytkowników CLI).
  - Zadanie CI liczy się dla npm, gdy samo instaluje przez npm; dla `runtime-end-of-life`, gdy uruchamia `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun` lub `corepack`. Zadanie, które tylko testuje akcję na starym runnerze (jak `old-node` w `action-test.yml`), nie jest zgłaszane.
  - Dane są stanem z 2026-11-01: dokładna wersja nowsza niż najnowsze znane wydanie linii daje uwagę, a zakres obejmuje tylko znane wydania.
  - `npm ci` według niepewnego faktu `lockfileInstalls` nie stosuje `min-release-age`, ale pozostałe ustawienia (skrypty, źródła) tak; reguła tych przypadków nie rozróżnia.
  - `pinnedVersion` w `apply` widzi teraz także podmianę npm w Dockerfile (z najniższym priorytetem, jak wcześniej podmianę w CI).
- **Repozytorium depcurfew.** Przypina npm 11.19.1, ale CI uruchamiało `npm ci` na Node 22 z npm 10 i na wcześniejszych 24.x i 26.x. To prawdziwe znalezisko: `ci.yml` i `release.yml` instalują `npm@11.19.1` przed `npm ci`, a `tests/meta/ci.test.ts` pilnuje, że to wersja z `packageManager`. `doctor .` znów mówi „No problems found.”.
- **Testy.** Fikstury `doctor` dla obu reguł (setup-node 22 i 24, podmiana npm w zadaniu, Dockerfile z Node 20, z ARG i wieloetapowy, Python 3.12 i 3.13, `.nvmrc`, Node 20 i `lts/iron`), fikstury wykrywania `docker-node` i `python-docker` oraz testy czytnika (kontynuacja, `# escape=`, komentarze, here-documenty, forma exec, dane patologiczne w czasie liniowym). Test fikstur `doctor` ustala datę na 2026-11-01, bo wynik zależy od tego, które linie są wspierane.
- **Zgodność wstecz.** Nowe pola i wartości w JSON (`jobs`, `dockerfiles`, `job`, `matrix`, `stage`, `version` obok `versionFile`, nowe `source`) i nowa reguła; `schemaVersion` zostaje 1. `${{ matrix.<klucz> }}` z listą wartości nie daje już uwagi „cannot evaluate”, tylko jest sprawdzane dla każdej wartości.
- **Niepewne:** dokąd przesuną się `node:current` i `node:latest` po wydaniu Node 27 i czy tagi usuniętych linii (`node:20`) są jeszcze na Docker Hubie (Hub był niedostępny); `Dockerfile.<nazwa>` bez oficjalnego źródła; czy linia `#` w here-documencie jest komentarzem; wersja npm, od której nieznany klucz jest błędem (12, z komentarzy w kodzie); obecność Corepacka w obrazach `node` (wniosek z tarballi).

## D-106 · Poprawki po przeglądzie 1.3.0: MCP, check i hook (2026-11-01)

- **Skąd.** Przegląd kodu MCP i `check` (A), pentest 1.3.0 (P) i test z tarballa (T) przed wydaniem 1.3.0. Każda poprawka ma test.
- **`AbortSignal.any` (A1, P7).** `requestSignal` w `src/check/registry.ts` używał `AbortSignal.any` (Node 18.17 i 20.3), a `engines` to `>=18.3.0` (D-103), więc na 18.3-18.16 i 20.0-20.2 każde wywołanie `check_packages` kończyło się `unverified`. Bez `AbortSignal.any` sygnał limitu czasu i sygnał wywołania łączy teraz ręcznie `AbortController`: pierwszy, który przerwie, przerywa zapytanie ze swoim powodem (`TimeoutError` zostaje). Test `tests/check/request-signal.test.ts` uruchamia `requestSignal` i `fetchPackument` z usuniętym `AbortSignal.any`. Próba dymna (`tests/runtime/smoke.mjs`) wywołuje `check_packages` przez lokalny rejestr i trzyma stdin otwarte do odpowiedzi, żeby sekunda po końcu stdin nie ucięła wolnego zapytania; CI uruchamia ją na 18.3.0 i 20.0.0.
- **Argument `directory` w MCP (A2, bezpieczeństwo).** Katalog w projekcie może mieć własny `depcurfew.json`, którego użytkownik nie pisał: paczka w `.venv/…/site-packages`, sklonowane repozytorium z własnym `.git` (wtedy obowiązywała polityka domyślna), plik zapisany przez agenta. `policy` w wyniku było względne wobec tego katalogu, więc wyglądało jak plik użytkownika.
  - Decyzja: polityka i `.npmrc` pochodzą zawsze z wyszukiwania od katalogu projektu (`--dir`, `CLAUDE_PROJECT_DIR`, bieżący katalog), cokolwiek mówi `directory`. Odrzucanie katalogów z inną polityką albo pod `.venv`, `site-packages` czy innym `.git` zostawiałoby agentowi wybór polityki tam, gdzie lista wyjątków jest niepełna; jedna polityka na projekt jest też zgodna z `projects` (D-100), gdzie katalog projektu nie może mieć własnej polityki (`project-has-policy`).
  - `directory` zostaje dla zgodności: musi istnieć w katalogu projektu (jak dotąd, także po `realpath`), a gdy ma własny `depcurfew.json` (albo bliższy niż projektu), wynik ma uwagę „`<ścieżka>/depcurfew.json` is not used …; tell the user if that directory should have a policy of its own”. Projekt z własną polityką dostaje osobny serwer z `--dir`.
  - `policy` jest pokazywane względem katalogu projektu (np. `../../depcurfew.json`, gdy polityka leży nad nim w tym samym repozytorium).
  - Hook nadal szuka polityki od `cwd` zdarzenia (D-078); ten sam problem w hooku (`cd vendor/x && npm i …`) zostaje otwarty.
- **Tekst, który trafia do modelu (A3, P6).**
  - `printable` i `safeJson` zapisują jako ucieczki także znaki formatujące `\p{Cf}` (m.in. U+200B-U+200F, U+2060-U+2064, U+FEFF, U+00AD), cały blok znaków tagów U+E0000-U+E007F i selektory wariantów U+FE00-U+FE0F i U+E0100-U+E01EF. Znaki dwukierunkowe należą do `\p{Cf}`, więc ich obsługa zostaje. `printable` pisze `\uHHHH` albo `\u{HHHHH}` poza BMP, `safeJson` parę surogatów `\uHHHH\uHHHH`, którą każdy parser JSON odczyta bez zmian. Wszyscy odbiorcy `printable` (`doctor`, `apply`, `explain`, `check`, Action) przechodzą swoje testy.
  - Klucze też: `forAgent` czyści klucze obiektów, a `lookups.scopes` w `explain_policy` to lista `{ scope, registry }` zamiast obiektu z kluczami z `.npmrc` (narzędzie nie było jeszcze wydane, więc `schemaVersion` zostaje 1).
  - Tekst wydawcy jest w cudzysłowie z ucieczką `\` i `"` (`quoted` w `src/check/findings.ts`): komunikat wycofania npm („is deprecated, with the message "…"”), treść skryptów instalacyjnych w `check` („postinstall: "node x.js"”) i powód statusu projektu PyPI („with the reason "…"”). Nazwy skryptów pochodzą z bazy wiedzy, więc zostają bez cudzysłowu.
  - Opisy narzędzi i `instructions` mówią, że tekst w cudzysłowie z rejestru lub indeksu napisał wydawca paczki i jest danymi, nie instrukcjami. Wskazówka „the deprecation message often names one” brzmi teraz „check a replacement the message suggests like any other package before installing it” (tak samo dla Pythona).
- **Wskazówki dla agenta w MCP i hooku (A4, A7).** `agentFix(fix, code)` w `src/check/hook.ts` jest wspólne dla hooka i serwera:
  - `unverified` z poprawką o rejestrze lub indeksie (ponów, gdy osiągalny, `--registry`, adres z przekierowaniem lub link-local z `fetchSameOrigin`) daje „Do not install it before it is checked. Which registry and index depcurfew asks is the user's setting … otherwise tell the user”; agent nie może podać `--registry` (z założenia, D-096);
  - `insecure-registry` mówi, że adres to ustawienie użytkownika i trzeba mu to przekazać, zamiast „Use an https:// URL”;
  - uwaga o polityce domyślnej dla agenta: „no depcurfew.json found, so the default policy of depcurfew init applies; tell the user if the project should have a policy of its own”, bez zachęty do `depcurfew init`. `check` w terminalu i `check --json` mają dotychczasowe teksty, bo człowiek albo agent w CLI może podać `--registry`.
- **Czas teraźniejszy w `explain_policy` (A5).** „check_packages looks npm packages up in … (--registry), not in the public npm registry” zamiast „were looked up”; wynik `check_packages` zostaje w czasie przeszłym, bo tam zapytanie się odbyło.
- **`"id": null` (A6).** Nowy fakt `environment.mcp.errorId` (`optionalSince: 2025-11-25`): schematy 2024-11-05 i 2025-06-18 wymagają `id` w odpowiedzi z błędem, 2025-11-25 i 2026-07-28 nie. Odpowiedź na żądanie, którego identyfikatora nie da się odczytać (zły JSON, `"id": null`, obiekt jako `id`, wiadomość, która nie jest obiektem, za duża linia, partie), ma `"id": null` w rewizji przed 2025-11-25, jak w JSON-RPC 2.0 (jsonrpc.org był niedostępny, więc to nie jest sprawdzony fakt); w 2025-11-25 i 2026-07-28 nie ma `id`. Rewizja to `_meta` samej wiadomości, potem sesja; bez nich obowiązują najnowsze schematy (bez `id`). D-096 zakładało brak `id` wszędzie.
- **Nieczytelne zdarzenie hooka (T10).** Zamiast surowego komunikatu parsera z nową linią: `error: cannot read the hook event: <powód przez reasonText>` i `fix:` z tym, co wysyła Claude Code (jeden obiekt JSON na stdin, najwyżej 1 MiB), jak uruchomić hook i przykładowym zdarzeniem do ręcznej próby. Kod 2 bez zmian (D-056).
- **`explain_policy` przy błędnej polityce (T11).** `appliedPolicy` czyta `.npmrc` i opcje serwera przed polityką, więc wynik z błędem ma prawdziwe `lookups` (rejestr, indeks, scope'y) zamiast pustych.
- **Wycofana wersja w hooku (T9).** Reguła decyzji z D-056 zostaje: ostrzeżenia nie dają decyzji. Nowy fakt `environment.claudeCode.hookContext` (niepewny, `hooks#pretooluse-decision-control` i `#add-context-for-claude`, sprawdzone 2026-11-01): `additionalContext` w `hookSpecificOutput` dodaje tekst do kontekstu Claude obok wyniku narzędzia, jest ignorowane tylko przy `defer`, ponad 10 000 znaków trafia do pliku. Niepewne, bo strona nie mówi wprost, że działa bez `permissionDecision`. Hook wypisuje teraz ostrzeżenia (wycofana wersja, źródło, którego depcurfew nie sprawdza, HTTP) w `additionalContext`: bez decyzji sam `hookEventName` i kontekst, przy `deny` i `ask` obok powodu. Tekst jest stwierdzeniem, jak zaleca dokumentacja, z tym samym zdaniem o cudzysłowach i limitem 4000 znaków. Gdyby Claude Code pomijał kontekst bez decyzji, nic się nie psuje: wywołanie idzie zwykłym przepływem uprawnień jak dotąd.
- **README.** Sekcje „Claude Code” i „MCP server”: ostrzeżenia jako kontekst, komunikat przy nieczytelnym zdarzeniu, polityka zawsze z katalogu projektu, lista scope'ów, znaki niewidoczne i tekst wydawcy w cudzysłowie, wskazówki dla agenta.
- **Zgodność wstecz.** `schemaVersion` zostaje 1: komunikaty mają nowe brzmienie (cudzysłowy), nowe znaki są zapisywane jako ucieczki, które parser JSON czyta bez zmian, a zmiany w MCP dotyczą niewydanego narzędzia. W modułach: `agentFix` ma opcjonalny drugi parametr, `HookDecision` opcjonalne `context`, `policyNotices` opcjonalne trzecie `options`, nowe eksporty `quoted`, `INVISIBLE`, `REGISTRY_RETRY_FIX`, `INDEX_RETRY_FIX`, `DEPRECATED_FIX`, `LOOKUP_IS_THE_USERS`, `INSECURE_IS_THE_USERS` i typ `Lookups`.
- **Otwarte.** Polityka w hooku z `cwd` zdarzenia (jak wyżej); `additionalContext` bez decyzji nie był sprawdzony w prawdziwym Claude Code; tekst z błędu parsera JSON odpowiedzi rejestru (może cytować treść rejestru) trafia do `reason` bez cudzysłowu.

## D-108 · Hook bierze politykę z katalogu projektu (2026-11-01)

- **Problem (otwarte po D-106).** Hook szukał `depcurfew.json` od `cwd` zdarzenia w górę. Gdy Claude pracuje w podkatalogu projektu (narzędzie Bash zachowuje katalog po `cd`), łagodniejsza polityka w sklonowanym repozytorium z własnym `.git` (`vendor/lib/depcurfew.json`) albo w folderze paczki przeważała nad polityką projektu, a `.git` takiego klonu zatrzymywał szukanie i dawał politykę domyślną. Serwer MCP od D-106 bierze politykę zawsze z katalogu projektu.
- **Decyzja.** Gdy `CLAUDE_PROJECT_DIR` (fakt `claudeCode.sessionStart.projectDirVariable`; Claude Code ustawia go dla hooków) jest ścieżką bezwzględną w repozytorium git, a `cwd` zdarzenia leży w nim, hook szuka polityki od korzenia projektu (`hookPolicyStart` w `src/cli/check.ts`). Polityka bliższa `cwd` nie jest używana, a decyzja `deny`/`ask` mówi o tym w powodzie. Gdy katalog projektu nie leży w repozytorium git (folder z kilkoma repozytoriami) albo `cwd` jest poza nim, działa dotychczasowe szukanie od `cwd`; `--dir` nadal wygrywa. Testy w `tests/check/cli.test.ts`.
## D-107 · Poprawki po przeglądzie 1.3.0: projects, apply, explain, --user i Action (2026-11-01)

- **Skąd.** Przegląd projects i Action (B), pentest (P) i test paczki (T) wydania 1.3.0 oraz przegląd A (uwaga o `init`). Każda poprawka ma test albo fiksturę.
- **Zapis `apply` a podmieniony katalog (P5, bezpieczeństwo).** `projectProblems` sprawdzał katalogi projektów raz, przy planie, a `writeChanges` pisał później przez `join(root, 'frontend/.npmrc')`. Katalog podmieniony w tym czasie na symlink prowadził zapis poza repozytorium.
  - `writeChangeSets` sprawdza teraz katalog każdego pliku: przed `mkdir` najgłębszy istniejący katalog na drodze, po `mkdir` cały katalog pliku (`realpath` musi leżeć w `realpath` korzenia), a tuż przed każdym `rename` ten sam katalog jeszcze raz: musi mieć tę samą prawdziwą ścieżkę co przy zapisie pliku tymczasowego. Symlink, który zostaje w korzeniu, działa jak dotąd (tak samo przepuszcza go `Workspace`).
  - Błąd to `cannot-write` jak każdy inny błąd zapisu, z wycofaniem: „a directory on its path is a symlink that leads outside the directory depcurfew writes to” albo „a directory on its path changed while depcurfew was writing”, z poprawką („Make every directory on the way to … a real directory inside the repository rather than a symlink”, w `--user` „inside your home directory”). Plik już podmieniony jest przywracany tylko wtedy, gdy jego katalog się nie zmienił; inaczej trafia do `unrestored`.
  - Korzeń, którego jeszcze nie ma (`init --user` tworzy `~/.config/depcurfew`), liczy się jako prawdziwa ścieżka istniejącej części plus reszta.
  - Ograniczenie: między ostatnim sprawdzeniem a `rename` zostaje bardzo krótkie okno; zamknąć je całkiem mogłyby tylko wywołania względem deskryptora katalogu (`openat`, `renameat`), których Node nie udostępnia.
  - Test podmienia `frontend` na symlink przez nowe haki: `applyProject(root, { beforeWrite })` między planem a zapisem i `WriteOptions.staged` między plikami tymczasowymi a `rename`. Test `write-owner` z symlinkiem poza katalog domowy oczekuje teraz błędu zamiast zapisu (wcześniej plan i tak by go nie zawierał).
- **Action: adnotacje i pętla symlinków (P4).** Funkcja wybierająca pliki do adnotacji używała `statSync`, który przy pętli symlinków (`frontend/depcurfew.json` wskazujący na siebie) rzucał `ELOOP` z bezwzględną ścieżką runnera i przerywał krok. Teraz `lstat` i zwykły plik, w `try/catch`; symlink nie dostaje adnotacji (znalezisko zostaje w podsumowaniu i logu). Cały blok wpisu „depcurfew doctor” (przygotowanie i wysłanie) jest w `try/catch`: błąd to jedna linia w logu („the depcurfew doctor check was not added: a file could not be looked at (ELOOP)”), bez treści wyjątku, która może zawierać ścieżki.
- **Wpis „depcurfew doctor”: stare adnotacje (B4, zmiana D-104).** Adnotacji nie da się usunąć, a aktualizacja wpisu zostawiała adnotacje wcześniejszego przebiegu pod nowym wynikiem (push z błędami, potem czysty pull_request: `success` z adnotacjami błędów).
  - `external_id` to teraz `depcurfew:` i SHA-256 adnotacji przebiegu (`checkRunExternalId`); wpis rozpoznajemy po `depcurfew` albo przedrostku `depcurfew:`.
  - Wpis bez adnotacji jest aktualizowany i dostaje adnotacje jak dotąd. Wpis z adnotacjami jest aktualizowany tylko wtedy, gdy ma ten sam odcisk i wszystkie adnotacje (`annotations_count` równe ich liczbie); wtedy zostają, bo są dokładnie tymi z tego przebiegu.
  - W każdym innym przypadku (inne znaleziska, wpis wcześniejszej wersji bez odcisku, część adnotacji niedodana) akcja tworzy nowy wpis, a stary oznacza jako zastąpiony: `neutral`, `external_id: depcurfew:replaced`, tytuł „Replaced by a later run of depcurfew doctor on this commit” i zdanie, że jego adnotacje są z wcześniejszego przebiegu. Nowy wpis jest najnowszym o tej nazwie (`filter=latest`), więc kolejne przebiegi znajdują jego. Nieudane oznaczenie to dopisek w tej samej linii logu.
  - Wybraliśmy nowy wpis tylko przy różnicy, a nie zawsze przy adnotacjach, żeby powtórzony przebieg z tymi samymi znaleziskami nie mnożył wpisów. Najwyżej cztery żądania jak dotąd (wyszukanie, utworzenie, jedno dopisanie adnotacji lub oznaczenie starego wpisu; przy nieudanej aktualizacji wyszukanie, aktualizacja, utworzenie, dopisanie).
- **Konfiguracja botów w projekcie (B2, zmiana ograniczenia z D-100).** `frontend/renovate.json` czy `frontend/.github/dependabot.yml` dostawały znaleziska `bot-cooldown-mismatch` i `broad-exclusion`, których `apply` nie naprawia, bo botów w projekcie nie konfiguruje.
  - Nowe fakty: `renovate.extra.configLocation` (`lib/workers/repository/init/merge.ts` w 44.198.2: `detectConfigFile` szuka nazw z `configFiles` na liście plików repozytorium, czyli od korzenia; strona opcji: „Any config you define applies to the whole repository”, „Renovate always uses the config from the repository's default branch”) i `dependabot.extra.configLocation` („You must store this file in the .github directory of your repository in the default branch”, github/docs, czytane 2026-11-01), oba `verifiedAt` 2026-11-01.
  - W przebiegu projektu reguły botów nic nie zgłaszają; przebieg korzenia daje przy każdym takim pliku jedną notę `bot-cooldown-mismatch` („Renovate reads its configuration only from the repository root, on the default branch, so it does not read web/renovate.json in the project web; depcurfew apply configures Renovate only at the repository root, and its delay there covers web too”) z poprawką: przenieść ustawienia do konfiguracji w korzeniu (dla Dependabota z `directory: /web`) i usunąć plik. Bez faktu nota mówi tylko, że to konfiguracja projektu.
- **Projekt bez wpisu Dependabota (T12).** Nowy fakt `dependabot.extra.directories` (`directory` i `directories` względem korzenia, wzorce tylko w `directories`; options reference w github/docs). Gdy `.github/dependabot.yml` korzenia ma wpis dla któregoś projektu z `projects`, a dla innego projektu i jego ekosystemu żadnego, `bot-cooldown-mismatch` daje ostrzeżenie przy `updates` z katalogiem i poprawką („add an updates entry with package-ecosystem: npm and directory: /api … then run depcurfew apply to give it the cooldown”). Dopasowanie wzorca to heurystyka depcurfew (`**` dowolna głębokość, `*` w jednym katalogu), bo dokumentacja nie opisuje go dokładniej; w razie wątpliwości liczy się jako dopasowanie. Fikstury `fires-project-own-bot`, `fires-project-without-entry`, `passes-project-entries`.
- **`nothing-to-configure` w projekcie (B5).** Gdy `targets` pomija menedżera znalezionego w projekcie, komunikat mówi to wprost („frontend: no tools to configure: targets in depcurfew.json leaves out npm, found in frontend”, poprawka: dopisać `"npm"` do `targets` albo usunąć katalog z `projects`). Nazwa projektu nie jest już powtórzona: przedrostek dodaje `relocateReport`, więc treść ostrzeżenia jej nie zawiera.
- **`init` a katalog z własną polityką (B6).** `proposedProjects` odrzuca kandydatów tak jak `projectProblems` (w praktyce `project-has-policy`) i zwraca ich osobno; `init` mówi „deck is not in projects: deck/depcurfew.json is a policy of its own, and two policies for the same files are refused; …”, więc następne `apply` nie kończy się błędem.
- **Linia wpisu w `projects` (B7).** Linia problemu projektu pochodzi z pozycji elementu tablicy `projects` w `depcurfew.json` (`jsonElementOffsets` czytnika JSONC), a nie z pierwszego wystąpienia nazwy w pliku (np. w `cooldown.exclude`). Gdy pliku nie da się sparsować, zostaje dawne wyszukiwanie.
- **Tekst błędów `project-*` w `apply` (B9, T6).** Linia `error:` zaczyna się od pliku i linii, jak w JSON: „error: depcurfew.json (line 25): the project directory shared listed in projects does not exist (project-not-found)”. Komunikat, który już zawiera plik (`project-has-policy`), zostaje bez przedrostka.
- **`explain` (T7).**
  - W korzeniu z `projects` nie ma ostrzeżenia `nothing-detected`: korzeń zawiera projekty, które polityka wymienia.
  - Ostrzeżenia wykrywania w `explain --json` (korzeń i projekty) mają nowe pola `level` („warning”), `location` (pierwszy plik, gdy jest) i `fix`; `code`, `message` i `files` zostają, `schemaVersion` 1. Poprawki to te same co w `unreadable-config` dla nieczytelnych plików i krótkie zdania dla pozostałych kodów (`multiple-lockfiles`, `package-manager-mismatch`, `yarn-classic-unsupported` …). Tekst pokazuje poprawkę w linii `fix:` pod ostrzeżeniem.
  - Katalog z `projects`, którego nie da się użyć, jest błędem w `errors` (z linią wpisu) i daje kod wyjścia 1, jak w `apply`; opis kodu 1 w `--help` mówi o tym.
- **Błędy użycia z `--json` (T8).** Nieznana opcja, `check` bez paczki, `--json` z `--sarif`, za dużo argumentów, opcja innego polecenia, `--for` bez `--user` i pozostałe błędy z `run.ts`: z `--json` stdout ma dokument `{ schemaVersion: 1, errors: [{ code: "usage", level: "error", message, fix }] }` (bez `location`), stderr jest pusty, kod 2. Tylko dla poleceń, które mają `--json`: stdout `mcp` to protokół, a `init` nie ma JSON. Bez `--json` tekst się nie zmienia. Błędy użycia `check` i `doctor` są sprawdzane w `run.ts`, przed wywołaniem polecenia. Nowy kod `usage` w `APPLY_ERRORS` i README.
- **`doctor --user` a za stare narzędzie (T3, zmiana D-089).** npm 10.9.9 w PATH: `apply --user` nic nie zapisywał (`version-too-old`, `scripts-not-enforceable`), a `doctor --user` mówił „No problems found.” z samą notą.
  - Teraz to ostrzeżenie `user-config-drift` na narzędzie: „npm 10.9.9 is too old for the user policy: it lacks an allow-list for install scripts and min-release-age (added in 11.10.0), so depcurfew apply --user writes nothing to ~/.npmrc and the user policy does not protect npm: the install scripts of dependencies still run and new versions install without the release-age delay”, poprawka „Update npm to 11.16.0 or later (npm install -g npm@11.16.0), then run depcurfew apply --user; or pass the installed version with --for …”. Wersja w poprawce to najwyższa z wersji, które podają poprawki planu. Gdy `apply --user` pisze część ustawień (plik ma blok depcurfew), komunikat mówi „too old for part of the user policy … does not fully protect”. `--strict` kończy się wtedy kodem 1.
  - Nota z fragmentem „does not write it to” znika. `version-unknown` zostaje notą (shimy Corepacka mają wersję nieznaną, a poprawką jest `--for`, nie aktualizacja).
- **Python: `init` i `lockfile-install-scripts` (T5, A8).**
  - `showsBuilds` (`src/doctor/python-lockfiles.ts`): lockfile Pythona pokazuje budowanie ze źródeł, gdy jego format w bazie wiedzy ma listę plików (`wheels` albo `files`: uv.lock, poetry.lock, pdm.lock) albo to pylock.toml. Pliki requirements i Pipfile.lock mają tylko skróty, więc nie odróżniają paczki z kołami od paczki bez nich.
  - `init` radzi `depcurfew doctor` tylko wtedy, gdy jest taki lockfile; w przeciwnym razie `depcurfew check pypi:<name>` dla każdej paczki (oba zdania, gdy projekty różnią się pod tym względem).
  - `lockfile-install-scripts` jest „not applicable”, gdy jedynym wejściem Pythona są pliki requirements albo Pipfile.lock (`applies` z wykrywania), a przy takich plikach z paczkami z indeksu daje notę, że nie widzi kół, i odsyła do `check pypi:<name>`. Wymagania z repozytorium, z URL albo z lokalnej ścieżki nadal są zgłaszane i wtedy reguła ma „problems” (znalezisko zawsze wygrywa, D-098). Test `applies` z D-098 wymienia cztery fikstury z takimi wymaganiami i sprawdza, że bez `check` są „not applicable”, a z nim „problems”.
- **README: hook przed instalacją (T13, zmiana D-102).** Claude Code uruchamia hooka, a to node nie znajduje `cli.js`: kończy się kodem 1 i śladem stosu, co przy `onFailure: "block"` blokuje wywołanie. Sekcja generowana mówi teraz, co widać („failed; blocking because onFailure is "block"” i „Error: Cannot find module '…/node_modules/depcurfew/dist/cli.js'”) i co zrobić (instalacja w projekcie albo w `.claude/depcurfew` z terminala). Nowe pole faktu `environment.claudeCode.sessionStart.blockedNotice`; przykład z dokumentacji hooków (`#block-the-action-when-a-hook-fails`) ponownie przeczytany 2026-11-01.
- **Zgodność wstecz.** Nowe pola (`level`, `location`, `fix` w ostrzeżeniach `explain`), nowy kod `usage`, nowe wartości `external_id`, nowe znaleziska i noty; `schemaVersion` zostaje 1. Zmienia się kod wyjścia `explain` przy złym katalogu w `projects` (1 zamiast 0) i treść dokumentu z błędem użycia przy `--json` (wcześniej pusty stdout).
