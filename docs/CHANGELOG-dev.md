# Dziennik zmian (deweloperski)

Krótkie podsumowanie po każdej fazie planu. Decyzje i ich uzasadnienia są w `docs/decisions.md`.

## 2026-10-29 · Nowa nazwa: depcurfew, krótkie polecenie dcf

- Projekt nazywa się teraz `depcurfew`, bo nazwę `depgate` nosi już inne narzędzie z tej samej branży (D-062). Plik polityki to `depcurfew.json`.
- Paczka instaluje też krótkie polecenie `dcf`, które działa tak samo jak `depcurfew`.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą; paczka zainstalowana z tarballa uruchamia oba polecenia.

## 2026-10-29 · Poprawki komunikatów po teście w konsoli

- Gdy `apply` niczego nie zmienił, ale czegoś nie dało się zastosować (ostrzeżenia, fragmenty do dopisania ręcznie), pisze „No files changed; what depcurfew could not apply is listed below.” zamiast mylącego „the configuration already matches the policy”.
- Uwaga o spornych wersjach w bazie wiedzy pojawia się raz, na końcu listy brakujących ustawień, a nie przy każdej wersji.
- `apply` ostrzega o paczkach dopisanych ręcznie do listy dozwolonych skryptów (`allowScripts`, `allowBuilds`, `trustedDependencies` i podobnych), na które polityka nie pozwala. Mówi, że ich nie usuwa i co zrobić. Dotąd mówił o tym tylko `doctor`.

## 2026-10-29 · Czytelne komunikaty, kolory, pomoc poleceń i Action

- **Komunikaty:** wszystkie po angielsku i każdy błąd lub ostrzeżenie mówi, co zrobić. `apply` łączy brakujące ustawienia jednej wersji w jedno ostrzeżenie i podaje wersję, której trzeba wymagać (D-061).
- **Pomoc:** `depcurfew <polecenie> --help` z opisem, opcjami, przykładami i kodami wyjścia.
- **Kolory** w terminalu, bez zależności: obsługa `NO_COLOR` i `FORCE_COLOR`, a JSON i SARIF zostają bez zmian.
- **GitHub Action:** adnotacje na plikach i tabela w podsumowaniu zadania, każda z poprawką; nowe wejścia `annotations` i `job-summary`. README opisuje uruchomienie na GitLab CI.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.

## 2026-10-29 · Testy na projektach przykładowych i poprawki przed 1.0.0

- **Testy:** projekty przykładowe dla npm 12, pnpm 12/10, Yarn 4, Bun, Deno i npm 11 z ręczną konfiguracją; depcurfew zainstalowany z tarballa. Opóźnienie, źródła i skrypty sprawdzone prawdziwymi instalacjami (D-060).
- **Poprawione:**
  - `doctor` czyta dwudokumentowy `pnpm-lock.yaml` z pnpm 12;
  - Bun dostaje `"trustedDependencies": []`, żeby wbudowana lista zaufanych paczek nie uruchamiała skryptów;
  - npm 11.16+ dostaje `strict-allow-scripts=true`;
  - starszy npm daje ostrzeżenie, że zakazu skryptów nie da się wyegzekwować.
- **Macierz 26 wersji** npm, pnpm, Yarn, Bun i Deno, od najstarszej wspieranej do najnowszej:
  - pnpm 11.0–11.0.3 i 12.0–12.2 dostają `minimumReleaseAgeStrict: true`;
  - dla pnpm 10.16.x `apply` ostrzega, a `doctor` zgłasza pominięte dokładne wersje;
  - Yarn dostaje `npmMinimalAgeGate` od 4.10.2, bo 4.10.0–4.10.1 odrzucały też dojrzałe wersje (D-060).
- **Yarn Classic:** przy obecnej polityce `doctor` zgłasza błąd, bo żadne ustawienie nie działa w Yarn 1.x.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.

## 2026-10-29 · Przegląd przed wydaniem 1.0.0

- **Przegląd:** kod, bezpieczeństwo (repozytorium jako dane niezaufane) i działanie zainstalowanej paczki na Node 22.0, 22 i 24 (D-052).
- **Poprawione błędy, przez które `doctor` przepuszczał niedziałającą politykę:**
  - ręczne `dangerously-allow-all-scripts`;
  - pliki, których nie da się odczytać, sparsować albo edytować; teraz zgłasza je nowa reguła `unreadable-config`;
  - wersje przedpremierowe;
  - wpis lockfile'a npm bez `resolved`.
- **Bezpieczeństwo:**
  - żadnego odczytu ani zapisu przez symlinki wychodzące poza repozytorium: `depcurfew.json`, `init --force`, SARIF i `directory` w Action;
  - wzorce bez wykładniczego backtrackingu;
  - log Action z wyłączonymi poleceniami workflow.
- **Edycja plików:**
  - `apply` nie psuje YAML w stylu `{ ... }`, wieloliniowych wartości TOML ani tabel `install` zdefiniowanych kluczami z kropką;
  - nie zmienia stringów JSONC;
  - nie gubi komentarzy w JSON;
  - przy błędach nie wypisuje częściowego diffu.
- **Zgodność `apply` i `doctor`:** Dependabot `semver-*-days`, wpisy z wersją na listach dozwolonych, Renovate w `package.json`.
- **Plan fazy 7** zatwierdzony (D-053).
- **Testy:** 794, wszystkie przechodzą.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą, a `doctor` na sobie kończy się kodem 0.

## 2026-10-29 · Faza 8: bezpieczna publikacja (gotowa, czeka na wydanie)

- **Workflow wydania** `.github/workflows/release.yml`: z tagu `vX.Y.Z` przez trusted publishing (OIDC) z proweniencją, bez tokenu npm. Wykonuje tylko `npm stage publish`, a wersja staje się publiczna po zatwierdzeniu z 2FA. Przed etapowaniem uruchamia wszystkie testy i `depcurfew doctor` na sobie (D-046).
- **`docs/RELEASING.md`:** jednorazowa konfiguracja po stronie właściciela (2FA, utworzenie paczki przez etapowanie i odrzucenie wersji próbnej, `npm trust github --allow-stage-publish`, zakaz tokenów, wydanie w ciągu 2 dni) oraz kroki każdego wydania z weryfikacją proweniencji.
- **depcurfew stosuje własną politykę:** `depcurfew.json`, blok w `.npmrc` z `depcurfew apply` i `packageManager: npm@11.19.1`. `doctor` na sobie kończy się kodem 0 z jednym ostrzeżeniem (`fsevents`), czego pilnuje test (D-047).
- **Wersja 1.0.0** w `package.json`.
- **`lockfile-install-scripts`** uwzględnia wyłącznik wszystkich skryptów (np. `ignore-scripts=true`); zmiana wyszła przy stosowaniu polityki na sobie (D-048).
- **Baza wiedzy:** fakty o trusted publishing, publikacji etapowej i `npm trust` (D-049).
- **Testy:** 715, wszystkie przechodzą.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.
- **Do zamknięcia fazy** brakuje wydania 1.0.0 z proweniencją po ręcznych krokach właściciela (D-050).

## 2026-10-29 · Faza 6: GitHub Action i README

- **GitHub Action** (`action.yml`, D-040): uruchamia `doctor`, wysyła SARIF do code scanning i kończy zadanie błędem przy błędach `doctor`. Działa z własnego checkoutu przez zatwierdzony bundel `action/depcurfew.mjs` z dołączonym `yaml`. Test i CI pilnują, że bundel jest identyczny ze świeżym buildem (D-041).
- **Przypięcie do SHA:** wszystkie akcje (`actions/checkout`, `actions/setup-node`, `github/codeql-action/upload-sarif`) są przypięte do pełnych SHA, czego pilnuje test (D-042).
- **Workflow:** `ci.yml` (Node 22 i 24) i `action-test.yml`, czyli test akcji na samym depcurfew i na fiksturach. Oba przeszły na GitHubie, łącznie z prawdziwą wysyłką SARIF i instalacją Node 22 na runnerze z Node 20 (D-044).
- **README:** start w 5 minut, polecenia, polityka, tabela narzędzi z bazy wiedzy z datą weryfikacji, opis każdej reguły `doctor` i użycie Action. Sekcje z faktami generuje `npm run docs:readme`, a test pilnuje, że proza nie podaje nazw ustawień spoza tych sekcji (D-043).
- **Baza wiedzy:** fakt o wysyłce SARIF (akcja, wejścia, uprawnienia) w dziale „środowisko”.
- **Testy:** 704, wszystkie przechodzą.
- **Weryfikacja:** `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą lokalnie i w CI.

## 2026-10-29 · Faza 5: `depcurfew doctor`

- `depcurfew doctor [katalog] [--json | --sarif]` wykrywa konfigurację, która po cichu nie działa, i odchylenia od `depcurfew.json` (D-034):
  - zgłoszenia mają poziom, plik, linię i podpowiedź naprawy;
  - kod wyjścia 1 przy błędach;
  - SARIF 2.1.0 do skanowania kodu w GitHubie;
  - bez polityki działają reguły, które jej nie potrzebują.
- Dziewięć reguł (D-035):
  - `manager-version-too-old`, `setting-ignored-by-version`;
  - `npmrc-overrides-policy`, `pnpm-shared-workspace-lockfile`;
  - `config-drift`, `bot-cooldown-mismatch`, `broad-exclusion`;
  - `lockfile-forbidden-source`, `lockfile-install-scripts`.
- Odstępstwo od planu: `shared-workspace-lockfile=false` w pnpm 10 nie ma oficjalnego potwierdzenia, że „unieważnia opóźnienie”. Reguła zgłasza `.npmrc` pakietu, który w tym trybie nadpisuje ustawienia workspace'u, co wynika z kodu pnpm (D-036).
- `config-drift` ostrzega też o wpisach w allowlistach narzędzi spoza polityki, których `apply` celowo nie usuwa.
- Baza wiedzy: 9 nowych faktów (formaty plików blokad, `.npmrc` w npm i pnpm 10) i 7 ustrukturyzowanych form faktów z fazy 1, wszystkie ze źródłami (D-037).
- Testy (686, wszystkie przechodzą):
  - fikstury „uruchamia się” i „nie uruchamia się” dla każdej reguły (D-038);
  - raport SARIF każdej fikstury przechodzi walidację oficjalnym schematem OASIS (własny walidator, bez nowych zależności);
  - po `apply` na wszystkich 18 fiksturach repozytoriów `config-drift` nie zgłasza błędów;
  - CLI w procesie i e2e.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą. `node dist/cli.js doctor .` na samym depcurfew nie zgłasza problemów.

## 2026-10-28 · Faza 4: generatory konfiguracji

- `depcurfew apply [katalog] [--dry-run]` zapisuje politykę w konfiguracji każdego narzędzia docelowego (D-028):
  - osobny generator dla npm, pnpm, Yarn (Berry), Bun, Deno, Renovate i Dependabota (`src/apply/generators/`);
  - nazwy opcji, pliki, wersje minimalne i formaty pochodzą z bazy wiedzy;
  - ustawienie, którego wersja menedżera jeszcze nie ma, oraz element polityki, którego narzędzie nie umie wyrazić, dają ostrzeżenie zamiast cichego pominięcia;
  - `--dry-run` wypisuje zunifikowany diff, który przyjmuje `git apply`, i niczego nie zapisuje;
  - gdy któregoś pliku nie da się edytować, nic nie jest zapisywane i kod wyjścia to 1.
- Boty dostają opóźnienie nie krótsze niż najdłuższe zapisane przez menedżera (`botDuration`), więc Dependabot i Renovate nie proponują wersji, których menedżer jeszcze nie zainstaluje.
- Edytory zachowują komentarze i formatowanie (D-029):
  - `.npmrc` i `bunfig.toml` dostają zarządzany blok ze znacznikami, a stary zapis zarządzanego klucza poza blokiem jest zakomentowany;
  - YAML jest zmieniany minimalną edycją tekstu ze znacznikiem `# managed by depcurfew`;
  - JSON i JSONC zachowują komentarze, przecinki na końcu i wcięcia;
  - końce linii, BOM i końcowy znak nowej linii zostają jak w oryginale;
  - depcurfew nie zapisuje przez symlinki ani poza repozytorium, a zapis jest atomowy.
- Zasady łączenia z istniejącą konfiguracją (D-030): allowlisty skryptów są tylko uzupełniane, listy wyjątków od opóźnienia zastępuje polityka, a przełączniki „pozwól na wszystkie skrypty” są wyłączane przy `deny`. `renovate.json5` i klucz `renovate` w `package.json` dostają fragment do wklejenia.
- Baza wiedzy: 20 nowych faktów w `extra` (składnia list w `.npmrc`, przełączniki „pozwól na wszystko”, obsługa globów w wyjątkach, dawna allowlista pnpm, ekosystemy Dependabota, reguła wyłączenia w Renovate i inne), wszystkie ze źródłami (D-031).
- Testy (507, wszystkie przechodzą):
  - 18 fikstur repozytoriów z oczekiwanym wynikiem w `expected/<nazwa>/after/` i raportem `apply.json`, w tym 4 nowe (D-032);
  - każda fikstura sprawdza wynik, brak utraty niezarządzanych ustawień i idempotencję (drugie `apply` nie zmienia żadnego pliku);
  - testy edytorów INI, TOML, YAML, JSONC, stylu tekstu i diffu;
  - CLI: `--dry-run` z nałożeniem diffu na pliki, brak i błąd polityki, zepsuty plik, symlink, opóźnienie botów po zaokrągleniu przez npm;
  - e2e na zbudowanym `dist/cli.js`.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.

## 2026-10-28 · Faza 3: wykrywanie projektu

- `src/detect/` opisuje repozytorium (D-025):
  - menedżery paczek z dowodami użycia: plikami blokad, `packageManager`, `devEngines`, plikami konfiguracyjnymi i krokami w CI;
  - wersje menedżerów i Node.js zadeklarowane w `packageManager`, `devEngines`, Volcie, `.tool-versions` i GitHub Actions, z plikiem i linią;
  - boty (Renovate, Dependabot), workspace'y z listą pakietów, pliki `.npmrc` i workflow;
  - ostrzeżenia, m.in. o kilku plikach blokad, niezgodnym `packageManager` i Yarn Classic.
- Detektor tylko czyta pliki: nie wychodzi poza repozytorium (także przez symlinki), pomija `node_modules`, `.git` i pliki powyżej 1 MiB.
- `depcurfew explain [katalog] [--json]` pokazuje wynik wykrywania. Jeśli w repozytorium jest `depcurfew.json`, dokłada wartości opóźnienia przeliczone dla każdego narzędzia docelowego (D-026). `init` wypisuje wykryte narzędzia.
- Baza wiedzy:
  - sekcja `project` dla menedżerów paczek;
  - nowy dział „środowisko” (Corepack, `devEngines`, Volta, asdf, akcje GitHub Actions) z własną listą oficjalnych źródeł;
  - fakty o znacznikach `yarn.lock` i o kluczu `renovate` w `package.json` (D-023, D-024).
- Pierwsza zależność w czasie działania: `yaml@2.9.1`, bez zależności przechodnich (D-022).
- Testy (432, wszystkie przechodzą):
  - 14 fikstur repozytoriów z oczekiwanym `detect.json`;
  - przypadki brzegowe: zepsuty JSON i YAML, zły `packageManager`, za duży plik, symlinki poza repozytorium, wzorce workspace'ów z `..`, `**` bez `node_modules`, wyrażenia w workflow;
  - `explain` w procesie i e2e;
  - walidacja działu „środowisko”.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą. `node dist/cli.js explain .` poprawnie opisuje samo repozytorium depcurfew.

## 2026-10-28 · Faza 2: plik polityki i walidacja

- Plik polityki `depcurfew.json` (D-015):
  - zdefiniowany raz w `src/policy/schema.ts`;
  - z tej samej definicji powstają walidator, typy `Policy` i `ResolvedPolicy` oraz `schema.json` w wersji draft-07 (D-016);
  - `schema.json` generuje `npm run schema` i trafia do paczki.
- Walidator (`src/policy/validate.ts`):
  - zgłasza wszystkie błędy naraz, każdy ze ścieżką do pola, np. `cooldown.exclude[1]: …`;
  - podpowiada przy literówkach w polach i wartościach;
  - błędy JSON mają linię i kolumnę;
  - reguły zależne od kilku pól: lista `allow` bez efektu oraz maksimum Dependabota przy jawnych `targets`.
- Czas trwania (`src/policy/duration.ts`):
  - przyjmuje `36h`, `3d`, `1w` itp.;
  - odrzuca zero, ułamki, spacje, wielkie litery, jednostki słowne i złożone, wiodące zera, miesiące, lata i sekundy;
  - komunikat podpowiada poprawny zapis (D-017).
- Przeliczanie (`src/policy/convert.ts`):
  - jednostki, słowa Renovate i maksima pochodzą z bazy wiedzy;
  - wynik jest zawsze zaokrąglony w stronę dłuższego opóźnienia;
  - spór o jednostkę rozstrzyga najmniejsza jednostka;
  - przekroczenie maksimum to błąd zamiast skrócenia opóźnienia (D-018).
  - Przykład dla 36h: npm i Dependabot 2 dni, pnpm/Yarn/Deno 2160 minut, Bun 129600 sekund, Renovate `"36 hours"`.
- `depcurfew init [katalog] [--force]` zapisuje domyślną politykę i bez `--force` nie nadpisuje istniejącego pliku (D-019).
- Baza wiedzy: dwa nowe fakty, Renovate `extra.durationUnits` i Dependabot `extra.maximumDays`. Zweryfikowałem je w plikach źródłowych dokumentacji, bo sieć blokowała strony z dokumentacją (D-020).
- Testy (375, wszystkie przechodzą):
  - 21 fikstur polityk w `tests/fixtures/policies/` (wejście i oczekiwany wynik albo oczekiwane komunikaty);
  - przeliczenia każdej jednostki na granicach oraz pełny przegląd 1–20 000 minut, który sprawdza, że wynik nigdy nie daje krótszego opóźnienia;
  - jednostki sporne i brakujące na syntetycznej bazie;
  - zgodność `schema.json` z walidatorem;
  - `init` w procesie i e2e.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.

## 2026-10-28 · Faza 1: baza wiedzy o menedżerach paczek

- `src/knowledge/` zawiera jeden moduł na narzędzie: npm, pnpm, Yarn (Berry), Bun, Deno, Renovate i Dependabot. Razem to 184 fakty: 142 zweryfikowane, 28 niepewnych i 14 spornych. Każdy fakt ma `source` (oficjalny URL) i `verifiedAt` (2026-10-28).
- Zakres:
  - opóźnienie: nazwa opcji, pliki, flaga CLI, jednostka, wersja minimalna, wartości domyślne zależne od wersji, wyjątki i ich składnia, zachowanie wobec aktualizacji bezpieczeństwa;
  - skrypty instalacyjne: domyślna polityka, allowlista, wyłącznik;
  - źródła git, zdalnych tarballi, lokalnych plików i katalogów (tylko menedżery paczek);
  - fakty dodatkowe dla `doctor`.
- Mechanika:
  - `validate.ts` odrzuca wpis bez źródła, ze źródłem spoza oficjalnych domen, z błędną lub przyszłą datą, spór z jednym wariantem lub bez notatki i wartość bez źródła (D-012, D-013);
  - `render.ts` generuje `docs/knowledge.md` z tabelami, sekcją „Additional facts”, notatkami i listą „To review”;
  - `npm run docs:knowledge` waliduje bazę przed zapisem.
- Testy (101, wszystkie przechodzą):
  - walidator na celowo zepsutych wpisach;
  - renderer na syntetycznej bazie;
  - prawdziwa baza: komplet narzędzi i faktów, zero błędów walidacji, `docs/knowledge.md` zgodny z bazą.
- Najważniejsze różnice względem punktów wyjścia z planu:
  - npm 12 jest wydany (12.0.0, 2026-07-08): domyślnie blokuje skrypty zależności, a `allow-git`/`allow-remote` mają domyślnie `none`;
  - pnpm 12 jest bieżącą wersją główną. pnpm 11 usunął `onlyBuiltDependencies` na rzecz `allowBuilds` i nie czyta już ustawień innych niż uwierzytelnianie i rejestr z `.npmrc`;
  - Yarn ma od 4.14.0 skrypty domyślnie wyłączone, a `npmMinimalAgeGate` od 4.15.0 domyślnie `1d`. Migracja lockfile'a w starych projektach wpisuje łagodniejsze wartości;
  - Bun od 1.4.4 przyjmuje jednostki czasu, a `trustedDependencies` zastępuje wbudowaną listę zaufanych paczek;
  - Deno od 2.9.0 ma domyślne opóźnienie 24 h (liczba oznacza minuty);
  - Dependabot od 2026-07-14 ma domyślny cooldown 3 dni, a Renovate ma flagę CLI `--minimum-release-age`.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą.

## 2026-10-28 · Faza 0: szkielet repozytorium

- Dodano szkielet CLI w TypeScript, tylko ESM:
  - `src/cli.ts` (shebang, `process.exitCode` bez top-level await);
  - `src/cli/run.ts` (`util.parseArgs`, kody wyjścia 0/1/2);
  - pomoc z poleceniami `init`, `apply`, `doctor` i `explain` oznaczonymi jako „planned”;
  - `--version` czyta wersję z `package.json`.
- Narzędzia: tsdown 0.22.14, Vitest 4.1.12, TypeScript 6.0.3 (`tsc --noEmit`), publint 0.3.25, @arethetypeswrong/cli 0.18.5 (profil `esm-only`). Zależności w czasie działania: brak.
- Testy (43, wszystkie przechodzą):
  - CLI w procesie;
  - e2e na zbudowanym `dist/cli.js` (shebang, `--help`, `--version`, kod 2);
  - kształt `package.json` (ESM-only, w `dependencies` tylko `yaml`, MIT);
  - skaner ESM na parserze TypeScript (brak top-level await i CommonJS w `src/` i `scripts/`);
  - wymuszona blokada sieci w testach.
- Higiena repozytorium: `.npmrc` z `save-exact`, `ignore-scripts` i `min-release-age=7`, `.gitattributes` z LF, `.gitignore` (z `docs/PLAN.md`, bo plan jest lokalny), licencja MIT (posiadacz praw: DevXord).
- Ręcznie wybrano vitest 4.1.12 z poprawką GHSA-qxg6-89mg-rqv8 i GHSA-xp26-3454-mjgp (D-008).
- `CLAUDE.md` powstał z sekcji 5 planu i ma dopiski: zgoda na zależności, zakaz publikacji i push bez zgody, lokalny `docs/PLAN.md`, Node ≥ 22.18 do pracy.
- Weryfikacja: `npm test`, `npm run typecheck` i `npm run check:pkg` przechodzą. `node dist/cli.js --help` kończy się kodem 0.
