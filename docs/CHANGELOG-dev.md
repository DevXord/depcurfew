# Dziennik zmian (deweloperski)

Krótkie podsumowanie zmian w projekcie. Decyzje i ich uzasadnienia są w `docs/decisions.md`.

## 2026-11-01 · 1.3.0: MCP, `doctor --strict`, `projects`, npm z wersji Node i Dockerfile, `--user` i Action (D-096–D-104)

- Dla zespołu z kilkoma niezależnymi katalogami, npm 10 w obrazach i backendem w Pythonie (np. frontend z `Dockerfile.ssr` na `node:20-alpine`, backend z `python:3.12-slim`): `projects` (D-100), npm i pip z wersji Node i Pythona, pliki wersji Node i Dockerfile (D-099), README o hooku przed instalacją depcurfew, przypięciu wersji i granicach narzędzia, uwaga o budowaniu Pythona w `init` (D-102), najniższy Node dla CLI (D-103).
- Fakty o MCP i jego klientach, o Node, npm i obrazach Docker, o Checks API i hookach Claude Code są ustalone u źródeł.
- Decyzje: D-096 (serwer MCP), D-097 (`doctor --strict`, ostrzeżenie Node o NO_COLOR), D-098 i D-104 (not applicable; Action `fail-on`, adnotacje, jeden wpis na commit), D-099, D-100, D-101 (`init --user`, wersje Yarn z plików, Poetry i PDM na macOS według platformdirs, jednostka Deno), D-102 i D-103.
- Zakres reguły ma typ `RuleScope`, żeby nie kolidował z typem `ProjectView`; `applies` dla `invalid-project` i `runtime-end-of-life`; `usesManager` w korzeniu widzi menedżery projektów; `relocateDetection` przenosi `jobs` i `dockerfiles`; deklaracje z CI mają `step`, więc instalacja liczy się tylko po swoim kroku `setup-node` (zadanie `runtime` buduje na Node 24, a uruchamia na starym Node). CI repozytorium instaluje npm z `packageManager` przed `npm ci`.
- Na Node 24 i 26 ostrzeżenie NO_COLOR przychodzi przed wykonaniem modułu, więc polecenia są ładowane dynamicznie po filtrze; na Node 18 przed 18.17 `fetch` ostrzega jako eksperymentalny, co też usuwa filtr. Najniższy Node dla CLI, ustalony w CI: 18.3.0.
- Poprawki: D-105 (czas liniowy i limity wykrywania, `npm -g`, pnpm/Yarn/Bun w CI, `working-directory`, `strict-allow-scripts` z npm wynikającego z Node), D-106 (MCP: `AbortSignal.any`, `directory`, niewidoczne znaki, poprawki dla agenta, `id: null`, kontekst ostrzeżeń w hooku), D-107 (wyścig symlinku przy zapisie, ELOOP w Action, nieaktualne adnotacje, boty w projektach, błędy użycia jako JSON, `doctor --user` przy za starym narzędziu, uwaga o Pythonie w `init`), D-108 (hook bierze politykę z `CLAUDE_PROJECT_DIR`). Test platformdirs nie zapisuje do `/cfg` (na CI bez roota taki zapis się nie udaje).
- Poprawki: D-109 (`strict-allow-scripts` ze wszystkich miejsc npm, pliki wersji Node z korzenia dla projektów, duplikaty znalezisk, brzmienie), D-110 (hook: polityka projektu i bliższa naraz po `realpath`, zastąpiony wpis check run, SARIF przy błędzie użycia) i D-111 (npm każdego wydania Node, nieznany npm jak uruchamiający skrypty, ścieżki `COPY`, dziedziczenie plików wersji według rodzaju, `explain` z przypisaniem, `--json=x`).
- Poprawki: D-113 (hook, `check`, MCP: polityka projektu albo najbliższa, `.npmrc` z katalogu npm i rejestry Yarn, Bun, uv, zniekształcone zdarzenia blokują, pliki do 1 MiB, limit wersji), D-114 (skaner poleceń: `trap`, aliasy, `env -S`, skrypty menedżerów, `sudo -s`, CRLF, osłabianie polityki i zmiany konfiguracji w samym poleceniu), D-115 (npm z CI i Dockerfile'ów dla projektów, `npm ci` bez wymogu opóźnienia, `--ignore-scripts`, submoduły, kontenery zadań, `lts/-n`, pip bez opóźnienia, `doctor <projekt>`), D-116 (`lockfile-out-of-date`, `bot-rule-shortens-delay`, notatki według kontraktu komunikatów, linia i kolumna w położeniu, drobiazgi `--user` i Action), D-117 (`explain` mówi, co `installScripts` i `sources` znaczą dla każdego narzędzia), D-118 (katalog każdej instalacji w hooku: `cd`, `pushd`, `--prefix`). CHANGELOG ma sekcję „Upgrading from 1.2.0”.
- Poprawki: D-119 (zmiana katalogu w hooku tylko zaostrza, `$'…'`, aliasy bez wybuchu, `--no-` w skrótach nopt, `env -C`, `find -execdir`, `\` w PowerShell), D-120 (wzorce workspace'ów bez wykładniczego dopasowania, źródła Poetry, PDM i Pipenv, jawne indeksy uv, brak paczki przy niesprawdzonym rejestrze pyta), D-121 (czas liniowy dla skryptów CI i RUN, hash pdm.lock, config-drift, poprawki npm według engines, `unreadable-config` bez polityki), D-122 (`doctor --user` każde miejsce, linia błędnej polityki w tekście, poziomy w logu Action, `init --json`); poprawione uwagi o aktualizacji i README o wersji Action.
- Poprawki: D-123 (`env -S` jak GNU env, stos katalogów jak w bash, nazwy zmiennych budowane przez powłokę, `trap` DEBUG/ERR, `source`, aliasy z odstępem na końcu, `PIPENV_PIPFILE`, aktywacja venv bez pytania, linia poleceń do 1 MiB poniżej 2 s), D-124 (linia `script-not-followed`, bomba aliasów YAML bez polityki, nieczytelny plik bota, położenia błędów, `.npmrc` pakietu workspace'u).
- Wersja 1.3.0 w `package.json`.

## 2026-10-31 · Wydanie 1.2.0 i przykład Action z SHA wydania

- `depcurfew@1.2.0` opublikowana 21:06 UTC z tagu `v1.2.0` (commit 25fb616) przez trusted publishing, z proweniencją SLSA; pliki w rejestrze są bajt w bajt takie same jak kompilacja z tego tagu.
- Przykład Action w README przypina `DevXord/depcurfew@25fb6165f2d19767eb4d35c92606500e104b09f9 # v1.2.0` (`ACTION_RELEASE` w `src/docs/readme.ts`), z uprawnieniem `checks: write` dla wpisu „depcurfew doctor”.

## 2026-10-31 · 1.2.0, część 4: `--user` jak tryb projektu, konflikty z `deny`, `readLimited`, `checked` i wpis w Checks (D-088–D-095)

- Poprawione błędy, m.in.: `doctor --user` mówił „No problems found” przy osłabionej ochronie, diff pokazywał tokeny z `~/.npmrc`, corepack był odczytywany jako pnpm/Yarn 0.34.0, a `apply` przestawiało ręczne wpisy dla paczek z `deny`.
- Wspólny `readLimited` (`src/read-limited.ts`): tylko zwykły plik, `O_NONBLOCK`/`O_NOFOLLOW`, odczyt do limitu niezależnie od rozmiaru ze `stat` (FIFO, `/proc`).
- D-088: konflikty list narzędzia z `installScripts.allow`/`deny` (`deny-conflicts-with-file`), `check` i hook bez błędu dla `deny`, zapisane odmowy w `lockfile-install-scripts`, pnpm 10.1–10.25 `ignoredBuiltDependencies`, walidacja nakładania między ekosystemami i wzorcami.
- D-089: `doctor --user` porównuje treść z planowanym blokiem zamiast celów polityki, sprawdza miejsca nadrzędne (`[install]` pip, `[pip]` uv, `~/.npmrc` pnpm 10), fail closed (`user-policy-invalid`, `user-config-unreadable`), zmienne w każdej pisowni (`src/user/variables.ts`), bez sekretów, SARIF względem `HOME`, wersje tylko z paczki samego narzędzia.
- D-090: `apply --user` w zgodzie z trybem projektu (listy wyjątków, `cooldown-shortened`, `before=`, brakujące ostrzeżenia, znacznik bloku użytkownika, przywracanie linii pip).
- D-091: zapis wszystko albo nic przez wiele katalogów, ścieżki `~/` w komunikatach, względne `XDG_CONFIG_HOME`, brak katalogu domowego, `--for` z dwuczęściową wersją, ukrywanie sekretów w diffie, `safeJson`, własność pliku pod `sudo`, EPIPE.
- Ostrzeżenie `environment-overrides` w `apply --user` (zmienne bez wartości); pip czyta klucze z podkreśleniami jak z myślnikami (`only_binary` = `only-binary`; `UserFile.underscoresAsDashes`, według `configuration.py` pip 26.2.2).
- D-092: przełączniki wyłączające ochronę są włączone dla każdej wartości, której narzędzie nie czyta jako wyłączonej (pnpm `"false"`, `yes`, `=1`; potwierdzone na prawdziwym pnpm 10.28.0), klucze scalania YAML tam, gdzie narzędzie je stosuje (pnpm), `[pip] no-build` w uv nie jest osłabieniem, drobne poprawki `config-drift` i `explain`.
- D-093: `init --user` bez zakładania katalogu domowego i bez śladu stosu, `doctor --user` przy braku katalogu domowego i względnym `XDG_CONFIG_HOME`, `user-setting-overridden` dla pnpm 10, znaki sterujące w treści diffu, własność nowych plików pod `sudo`, konkretne poprawki w komunikatach.
- `apply --user` wyłącza przełączniki „uruchom każdy skrypt” w plikach użytkownika; CI: duży YAML parsowany raz (`readYamlDocument`), test `init --user` na Windows; długi myślnik (U+2014) zamieniony na „-” w całym repozytorium.
- D-094: `doctor` i Action mówią, co sprawdziły (`checked`: narzędzia, przeczytane pliki, każda kontrola z wynikiem), a czysty przebieg Action dodaje adnotację `notice`.
- D-095: Action dodaje check run „depcurfew doctor” z wynikiem i tabelą kontroli w zakładce Checks PR (Checks API, `checks: write`, `pull_request.head.sha`).

## 2026-10-31 · 1.2.0, część 3: `init`, `apply` i `doctor --user` (D-087), jawna blokada `deny`

- Sekcja `user` w bazie wiedzy dla konfiguracji użytkownika 10 menedżerów (źródła przypięte do tagów): pliki per wersja i system, ustawienia z wersjami, nieznane klucze, złe wartości, osłabiające wartości i zmienne.
- `src/user/`: położenie plików, wersje z plików (bez uruchamiania), polityka użytkownika, plan i zapis `apply --user`, `doctor --user` (`user-config-drift`, `user-config-weakens`, `user-environment-overrides`).
- CLI: `init --user`, `apply --user`, `doctor --user`, `--for narzędzie@wersja`; README z generowaną tabelą plików użytkownika i regułami `doctor --user`.
- `apply` zapisuje `installScripts.deny` jako jawną blokadę w npm, pnpm, Yarn i Deno; repozytorium ma `allowScripts: { fsevents: false }`.
- Poprawione notatki w bazie wiedzy: pnpm `allowAllBuilds` (odmowy blokują dopiero od 12.12.0), pnpm 10 bez globalnego `config.yaml`, spór o nieznane klucze `.npmrc` rozstrzygnięty (ostrzeżenie).

## 2026-10-31 · 1.2.0, część 2: ostrzeżenie o starszym depcurfew (D-086)

- Reguła `doctor` `depcurfew-outdated` i ostrzeżenie `apply` o tym samym kodzie, gdy projekt instaluje nowszy depcurfew niż uruchomiony (`node_modules/depcurfew/package.json`, potem `package-lock.json`).

## 2026-10-31 · 1.2.0, część 1: `installScripts.deny` (D-085)

- Nowe pole polityki `installScripts.deny`: paczki sprawdzone i celowo bez skryptów (np. `fsevents` z gotowym plikiem binarnym). `doctor` ich nie zgłasza, dopóki narzędzie nie uruchamia ich skryptów; dla Pythona blokada budowania ze źródeł. Walidacja nakładania się z `allow`.
- `schema.json`, README (sekcje generowane), `init` z `"deny": []`, bundel akcji.
- Repozytorium: `"deny": ["fsevents"]`, więc `depcurfew doctor .` nic nie zgłasza.

## 2026-10-31 · Wydanie 1.1.0 i przykład Action z SHA wydania

- `depcurfew@1.1.0` opublikowana 12:46 UTC z tagu `v1.1.0` (commit 77ecd93) przez trusted publishing, z proweniencją; plik w rejestrze jest bajt w bajt taki sam jak tarball przetestowany na 14 projektach.
- Przykład Action w README przypina `DevXord/depcurfew@77ecd935be36510cae04290423cb02681080403f # v1.1.0` zamiast `<full-commit-sha>`; wersja i commit są w `ACTION_RELEASE` w `src/docs/readme.ts`, a test pilnuje pełnego SHA i wersji nie nowszej niż `package.json`.
- `docs/RELEASING.md`: krok 7 mówi, gdzie zmienić SHA po wydaniu, i przypomina o `npm deprecate`.

## 2026-10-31 · Wydanie 1.0.0 ze starszego `main`, pełna wersja jako 1.1.0 (D-084)

- `depcurfew@1.0.0` opublikowana ze starszego `main` (commit 03bdb75, proweniencja z `release.yml`): bez `check`, hooka, Pythona i poprawek D-071–D-083. Pełna wersja ma numer 1.1.0, bo npm nie pozwala użyć 1.0.0 ponownie.
- `package.json` 1.1.0; `CHANGELOG.md` z 1.0.0 zgodną z opublikowaną paczką i nową sekcją 1.1.0; `docs/RELEASING.md` z ostrzeżeniem o kolejności (najpierw scalenie, potem tag).

## 2026-10-31 · Windows i hook, komunikaty i dokumentacja, jakość i wydajność (D-081 – D-083)

- Windows i hook (D-081): hook sprawdza narzędzia PowerShell i Monitor Claude Code (matcher `Bash|PowerShell|Monitor`), formy `cmd /c`, nazwy poleceń bez wielkości liter, `$env:` w PowerShell, `$SHELL -c`, `python3 -Im pip`; repozytorium w katalogu głównym dysku; zapis ponawiany przy zablokowanych plikach; `.gitignore` z `core.ignorecase`; CI na Linux i Windows z Node 22, 24 i 26. Bezpieczeństwo: nowe pliki z trybem z umask, powód hooka czyszczony i przycinany (bez treści skryptów), URL rejestru bez haseł, polityka z katalogu nadrzędnego tylko z katalogu użytkownika i bez `node_modules`, limit 1 MiB przy edycji.
- Wydanie i dokumentacja (D-082): ostrzeżenie o nieaktualnym `pdm.lock`, wskazówka w każdym ostrzeżeniu `apply`, błędy `init` z kodem, README zgodne z działaniem i z bezwzględnymi linkami.
- Jakość i wydajność (D-083): klucz `.npmrc` w cudzysłowie albo bez `=` nie omija już bloku; duże lockfile'e YAML parsowane raz i bez kwadratowego sprawdzania duplikatów (limit 16 MiB); spowolnienia `dependabot.yml`, `renovate.json`, `requirements.txt` i SARIF usunięte; spójny JSON przy błędnej polityce; wersje przedpremierowe; Yarn `npmScopes` i pnpm `permissions` w `doctor`; skrócone opcje pip w `requirements.txt`.
- Wydanie: `CHANGELOG.md` z notatkami 1.0.0 dla użytkowników; workflow wydania przyjmuje tylko tag na commicie z `main` i ma limit czasu.
- CI na Windows: `apply` po nieudanym zapisie usuwa utworzone katalogi także na Windows (wcześniej brał ścieżkę zwracaną przez `mkdirSync`, a ta ma tam postać `\\?\C:\...`); testy oczekują komunikatów, które daje dany system, a test ścieżki ze znakiem nowej linii nie działa na Windows, bo taka nazwa pliku jest tam niemożliwa.

## 2026-10-31 · `tag=` w hooku, `before-overrides-cooldown`, pnpm 6.32.1–9 i drobne poprawki (D-080)

- `tag=` z `.npmrc` tylko dla npm w hooku; `apply` ostrzega `before-overrides-cooldown`; pnpm 6.32.1–9 dostaje `pnpm.onlyBuiltDependencies` zamiast fałszywego `scripts-not-enforceable`; wskazówka `cooldown-shortened` dla plików JSON; pusta linia przed sekcją `.npmrc` zostaje; bez `insecure-registry` dla rejestru lokalnego; bez fałszywego ostrzeżenia o poprawkach bezpieczeństwa Renovate z pnpm; poprawki w README i D-078.

## 2026-10-31 · `.gitignore`, indeks git w wersji 4, czyszczenie tekstu, polityka z katalogu nadrzędnego i hook (D-079)

- Poprawione w kodzie z D-074–D-078: przepełnienie stosu przy `.gitignore` z tysiącami `**/`, zawieszenie na indeksie git w wersji 4, uwagi `check` z `.npmrc` bez czyszczenia, znaki dwukierunkowe w tekście, polityka z katalogu nadrzędnego poza repozytorium git, `python3 -c "$(curl …)"` w hooku, pnpm `--reporter` i `--loglevel`.

## 2026-10-30 · Edytory i zapis, `init` i `apply`, `doctor`, `check` i hook, wyjście, CLI i prawo (D-074 – D-078)

- Edytory i zapis (D-074): YAML nie psuje już `dependabot.yml` przy komentarzu na końcu wpisu, a wynik edycji YAML i JSON jest sprawdzany; osobne bloki uv i PDM w jednym `pyproject.toml`; zapis wszystkich plików albo żadnego (`cannot-write`); plik tymczasowy od razu z trybem oryginału; zakomentowane ustawienia wracają, gdy polityka przestaje nimi zarządzać; pliki spoza UTF-8 nie są edytowane.
- `init` i `apply` (D-075): `init` zachowuje najdłuższe istniejące opóźnienie, a `apply` ostrzega `cooldown-shortened`; `scripts-not-enforceable` dla pnpm < 10; wpisy bezpieczeństwa Renovate w `minimumReleaseAgeExclude` zostają; `file-ignored-by-git`; bez nowych manifestów (`manifest-missing`) i bez narzędzi widzianych tylko w CI (`tool-only-in-ci`).
- `doctor` (D-076): `before=` w `.npmrc`; `.npmrc` czytany jak przez `ini` (komentarze w linii, sekcje; blok przed pierwszą sekcją); szerokie reguły i presety Renovate; opóźnienie pnpm 10 z `.npmrc`; Dependabot `cooldown.include`; sam projekt w `Pipfile.lock` i `pylock.toml`, pylock przypisany po `created-by`; nieczytelne pliki jako `unreadable-config`; duże liczby TOML bez wyjątku.
- `check` i hook (D-077): skróty i prefiksy opcji npm i pnpm (`--reg`), przekierowania tylko w obrębie originu, uwaga o rejestrze z `.npmrc`, `insecure-registry`, adres link-local daje ask; wersja wybierana jak przez menedżer (`--tag`, `tag=`, `--pre`, `--no-binary`); menedżer z wersją za runnerem, więcej wrapperów i powłok, `bash <(curl …)` i `irm … | iex`; normalizacja nazw `pypi:` w polityce; limit 50 paczek na polecenie; `deno x`.
- Wyjście, CLI i prawo (D-078): znaki sterujące w tekście dla ludzi są widoczne jako `\xHH`; czytelne błędy wejścia z kodem i JSON (kod 2 dla złego katalogu); polityka z katalogu nadrzędnego; poprawki Action i SARIF; README z sekcjami „Trademarks” i „Network and privacy”, `SECURITY.md`, nota ISC w bundlu akcji, poprawiony opis listy PyPI.
- `docs/RELEASING.md`: krok przypisania paczki do organizacji npm `depcurfew`.

## 2026-10-30 · Znacznik YAML, wskazówki hooka, `file-unreadable` i podpowiedź dla Hatch (D-073)

- Poprawki: brak podwójnego znacznika YAML po naprawie rozjazdu, wskazówki hooka zależne od powodu, `file-unreadable` w `apply` i brak mylącego `python-tool-unknown` przy zepsutym pyproject.toml, podpowiedź dla Hatch.

## 2026-10-30 · PDM i Pipenv; Hatch przez uv (D-072)

- PDM: wykrywanie, `apply` w `[tool.pdm.resolution]` (opóźnienie, wyjątki, zakaz budowania z listą wyjątków), `doctor` dla `pdm.lock`, stałej daty i trybu uv, hook dla `pdm add`.
- Pipenv: wykrywanie, `apply` z `cool-down-period` w pełnych dniach i ostrzeżeniami o brakach, `doctor` dla `Pipfile.lock` i `resolver_backend = "pure-python"`, hook dla `pipenv install`.
- Hatch: bez własnych ustawień; README opisuje konfigurację przez uv albo zmienne pip.
- Fikstury `pdm-basic` i `pipenv-basic` (przed i po), nowe przypadki reguł `doctor`; nowe kody `exclude-unsupported` i `build-switch-environment-only`.

## 2026-10-30 · Python w `check` i w hooku (D-071)

- `check pypi:<wymaganie>` sprawdza paczki PyPI przez Index API: istnienie, podobne nazwy (5000 popularnych projektów), wiek najnowszego pliku wobec cooldownu, brak wheel (budowanie ze źródeł), wersje wycofane i status projektu. Nowe kody `yanked`, `archived`, `quarantined`; opcja `--index`.
- Własne PEP 440 (`src/check/pep440.ts`), parser wymagań z przeliczaniem ograniczeń Poetry (`src/check/python-spec.ts`) i klient indeksu (`src/check/pypi.ts`); klasyfikacja źródeł pip wspólna z `doctor`.
- Hook czyta polecenia pip, uv, Poetry i pipx, w tym `python -m pip`, skróty opcji, grupy krótkich opcji i zmienne wskazujące inny indeks.
- Nagrane odpowiedzi PyPI w `tests/fixtures/pypi` (`npm run record:registry -- pypi`), lista popularnych projektów w `src/knowledge/popular-python.ts` (`npm run data:popular -- pypi`).

## 2026-10-30 · `check --json` przy błędnej polityce (D-070)

- `check --json` przy błędnym albo nieczytelnym `depcurfew.json` daje dokument z `errors` (kształt jak w `apply --json`) i puste `packages` zamiast tekstu na stderr; kod wyjścia 1.
- Uwaga o braku polityki trafia w trybie JSON do `notices`; `apply`, `doctor` i `check` mają w trybie JSON pusty stderr.
- `policyErrorFix`: jedna poprawka dla `doctor` i JSON z `apply` i `check`.

## 2026-10-30 · Błędna polityka w `doctor` (D-069)

- Nowa reguła `invalid-policy`: błędny albo nieczytelny `depcurfew.json` to znalezisko `error` w tekście, `--json` (z `policy: "invalid"`) i `--sarif`, zamiast tekstu na stderr. Reguły bez polityki dalej działają.
- `runDoctor` domyślnie nadal rzuca `PolicyError`; opcja `invalidPolicy: "report"`. Akcja GitHub bez zmian.
- CLAUDE.md: nowa wersja `schemaVersion` tylko przy zmianie niezgodnej wstecz.

## 2026-10-30 · Jedno wydanie 1.1.0 (D-068)

- Strażnik instalacji (`check` i hook Claude Code), Python (uv, pip, Poetry) i `apply --json` wychodzą razem jako 1.1.0, po 1.0.0. `--user` wychodzi w 1.2.0.

## 2026-10-30 · `apply --json` i kody ostrzeżeń (D-067)

- Każde ostrzeżenie i błąd `apply` ma stały kod, komunikat i, gdy jest co zrobić, `fix`; katalog kodów w `src/apply/warnings.ts` i w README.
- Tekst wygląda jak w `doctor`: kod w nawiasie, a co zrobić w linii `fix:`.
- `apply --json` (także z `--dry-run`): jeden dokument na stdout ze zmianami i ich diffem, ostrzeżeniami, błędami, fragmentami do dodania ręcznie i podsumowaniem; stderr pusty. Błędna albo brakująca polityka też daje JSON.
- `ApplyReport.warnings` bez zmian typu; nowe pole `warningDetails`.
- `apply` nie edytuje pliku TOML, który się nie parsuje (wcześniej dopisywało blok i zgłaszało sukces); to teraz błąd `cannot-edit`.
- CLAUDE.md: zasada o wyjściu maszynowym jest spełniona przez wszystkie polecenia.

## 2026-10-30 · Python: `__proto__` w TOML, pliki `-r` i `-c`, ścieżki bez `./` i inne poprawki (D-066)

- Poprawki dla uv 0.13.6, Poetry 2.5.1 i pip 26.2.2, każda z testem:
  - klucz `__proto__` w TOML nie ukrywa już zależności z gita i nie zmienia `Object.prototype`;
  - `doctor` czyta pliki dołączane przez `-r` i `-c`, a nieczytelne dołączenie zgłasza jako `unreadable-config`;
  - wymaganie `libs/local-lib` albo `pkg-1.0.tar.xz` bez `./` to ścieżka, jak w pip;
  - `required-version` z `[tool.uv]` obok `uv.toml` nie jest brane za przypiętą wersję;
  - `apply` ostrzega, że po zmianie `exclude-newer` trzeba uruchomić `uv lock`;
  - błąd składni w `poetry.toml` trafia do `unreadable-config`;
  - workspace z `deno.jsonc` przy zepsutym `deno.json` znów jest wykrywany;
  - fakty o ścieżkach, archiwach, URL, `#egg=`, `pylock.<nazwa>.toml` i `pyproject.toml` są w bazie wiedzy;
  - usunięcie bloku ze środka pliku przywraca plik bez dodatkowej pustej linii.
- CLAUDE.md: stałe zasady komunikatów dla człowieka i dla AI.

## 2026-10-30 · Python (uv, pip, Poetry)

- **Baza wiedzy:** uv 0.13.6, pip 26.2.2 i Poetry 2.5.1, każdy fakt ze źródłem pod tagiem: opóźnienie wydań, budowanie ze źródeł, źródła zależności, pliki projektu, lockfile'e, przypinanie wersji. Do tego Dependabot (ekosystemy `pip` i `uv`), Renovate (datasource `pypi`, preset `security:minimumReleaseAgePypi`) oraz akcje CI: setup-python, setup-uv, snok/install-poetry i abatilo/actions-poetry.
- **Polityka (D-065):**
  - paczki Pythona mają prefiks `pypi:`, a nazwy bez prefiksu zostają nazwami npm;
  - `installScripts` w Pythonie oznacza budowanie ze źródeł: zakaz budowania, a paczki z listy dozwolonych są zawsze budowane ze źródeł.
- **Wykrywanie:** `uv.lock`, `poetry.lock`, `pylock.toml`, `requirements.txt`, `[tool.uv]` i `[tool.poetry]` w `pyproject.toml`, `uv.toml`, `poetry.toml`, `required-version` i `requires-poetry`, kroki CI oraz workspace uv.
- **apply:**
  - uv: blok w `uv.toml` albo w `[tool.uv]`;
  - Poetry: bloki `[solver]` i `[installer]` w `poetry.toml`;
  - pip: blok opcji w `requirements.txt` i instrukcja dla zmiennej środowiskowej;
  - Dependabot i Renovate dostają wyjątki swojego rejestru.
- **doctor:**
  - `lockfile-forbidden-source` i `lockfile-install-scripts` dla `uv.lock`, `poetry.lock`, `pylock.toml` i `requirements.txt`;
  - `bot-cooldown-mismatch` porównuje boty z uv i Poetry;
  - `manager-version-too-old` sprawdza wersje z konfiguracji narzędzi;
  - nowa reguła `python-config-ignored`.
- **Własny czytnik TOML** bez zależności, zgodny z `tomllib` na 1089 z 1090 plików z dysku.
- **Macierz prawdziwych wersji:** uv 0.9.16, 0.9.17, 0.9.25 i 0.13.6; Poetry 2.3.4, 2.4.0 i 2.5.1; pip 25.3, 26.0, 26.1 i 26.2.2. Za stare wersje po cichu wyłączają ochronę (szczegóły w D-065).
- **Poprawki:**
  - `--hash` w plikach z hashami nie jest już brany za nieznaną opcję;
  - wymaganie bez nazwy nie dostaje zmyślonej nazwy;
  - `apply` komentuje też tabelę `[tool.uv.exclude-newer-package]` i zapis z kropką, więc nie psuje TOML;
  - reguła Renovate dla nazw npm pomija PyPI (`!pypi`), gdy w repozytorium jest Python;
  - członkowie workspace'u Deno z samym `package.json` znów są wykrywani;
  - `only-binary = ":all:"` jako tekst jest rozpoznawane;
  - fakty w komunikatach pochodzą z bazy wiedzy;
  - usunięcie bloku z `requirements.txt` przywraca plik;
  - parsowane pliki TOML są zapamiętywane, a powtórzony kod scalony.

## 2026-10-29 · 1.0.0: marka zamiast danych autora, README na stronę npm

- Marka `depcurfew` zamiast danych autora: autor i `informationUri` w SARIF (strona paczki na npm); licencja wskazuje posiadacza praw (DevXord). `DevXord` zostaje tylko tam, gdzie wymaga go GitHub lub npm: w `uses:` w workflow i w adresie repozytorium (D-064).
- README bez noty „pre-release”, bo trafia na stronę npm.
- Publikacja: odrzucenie jedynego etapu próbnego wycofuje wersję zastępczą `0.0.0-stage`, a npm blokuje wtedy nazwę na 24 godziny, więc `docs/RELEASING.md` każe zostawić etap próbny do wydania 1.0.0. `bin` jest zapisany tak, jak normalizuje go npm (`dist/cli.js`), więc publikacja nie ostrzega o przepisaniu ścieżek.

## 2026-10-29 · Luka: tarball z URL na hoście rejestru; instalacja w projekcie

- `doctor` zgłasza w `package-lock.json` zależności zadeklarowane jako adres tarballa, także na hoście rejestru. npm pobiera je z pominięciem `min-release-age` (D-063). Zachowanie pnpm, Yarn i Bun ustalone na prawdziwych lockfile'ach.
- Dopasowanie zależności z URL po ścieżce instalacji (odporne na przepisany host rejestru) oraz `overrides` z URL z `package.json`.
- README: depcurfew jako zależność deweloperska projektu. Programiści nie muszą go instalować; inne CI uruchamia kopię z lockfile (`npm ci --ignore-scripts`, `npx --no`); instalacji globalnej nie polecamy zespołom.

## 2026-10-29 · Nowa nazwa: depcurfew, krótkie polecenie dcf

- Projekt nazywa się teraz `depcurfew`, bo nazwę `depgate` nosi już inne narzędzie z tej samej branży (D-062). Plik polityki to `depcurfew.json`.
- Paczka instaluje też krótkie polecenie `dcf`, które działa tak samo jak `depcurfew`.

## 2026-10-29 · Komunikaty `apply`: brak zmian, sporne wersje, ręczne wpisy na listach skryptów

- Gdy `apply` niczego nie zmienił, ale czegoś nie dało się zastosować (ostrzeżenia, fragmenty do dopisania ręcznie), pisze „No files changed; what depcurfew could not apply is listed below.” zamiast mylącego „the configuration already matches the policy”.
- Uwaga o spornych wersjach w bazie wiedzy pojawia się raz, na końcu listy brakujących ustawień, a nie przy każdej wersji.
- `apply` ostrzega o paczkach dopisanych ręcznie do listy dozwolonych skryptów (`allowScripts`, `allowBuilds`, `trustedDependencies` i podobnych), na które polityka nie pozwala. Mówi, że ich nie usuwa i co zrobić. Dotąd mówił o tym tylko `doctor`.

## 2026-10-29 · Czytelne komunikaty, kolory, pomoc poleceń i Action

- **Komunikaty:** wszystkie po angielsku i każdy błąd lub ostrzeżenie mówi, co zrobić. `apply` łączy brakujące ustawienia jednej wersji w jedno ostrzeżenie i podaje wersję, której trzeba wymagać (D-061).
- **Pomoc:** `depcurfew <polecenie> --help` z opisem, opcjami, przykładami i kodami wyjścia.
- **Kolory** w terminalu, bez zależności: obsługa `NO_COLOR` i `FORCE_COLOR`, a JSON i SARIF zostają bez zmian.
- **`check` i hook:** każde znalezisko mówi, co zrobić. Hook nie podsuwa agentowi zmian w `depcurfew.json`.
- **GitHub Action:** adnotacje na plikach i tabela w podsumowaniu zadania, każda z poprawką; nowe wejścia `annotations` i `job-summary`. README opisuje uruchomienie na GitLab CI.

## 2026-10-29 · Lockfile pnpm 12, `trustedDependencies` w Bun, `strict-allow-scripts`, wersje pnpm i Yarn, Yarn Classic

- **Zachowanie** opóźnienia, źródeł i skryptów w npm 12, pnpm 12/10, Yarn 4, Bun, Deno i npm 11 z ręczną konfiguracją ustalone prawdziwymi instalacjami (D-060).
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

## 2026-10-29 · Strażnik instalacji (`depcurfew check`, hook Claude Code)

- **`depcurfew check <spec...> [--json] [--dir] [--registry]`:**
  - sprawdza paczki przed instalacją: istnienie (możliwa wymyślona nazwa), wiek wybranej wersji względem `cooldown` z propozycją starszej, skrypty instalacji, podobieństwo do 5000 popularnych nazw i wycofanie;
  - git, URL-e i ścieżki porównuje z `sources`;
  - kod 1 przy naruszeniu albo braku możliwości sprawdzenia (D-056, D-058).
- **`depcurfew check --hook claude-code`:**
  - hook PreToolUse dla Bash: `deny` przy naruszeniu polityki, `ask`, gdy depcurfew nie może poręczyć za polecenie;
  - fail closed: nieczytelne zdarzenie daje kod 2.
  - Skaner czyta polecenie jak powłoka i śledzi zagnieżdżone polecenia (D-055). Sekcja README z przykładem `.claude/settings.json` jest generowana z bazy wiedzy.
- **Baza wiedzy** (D-054): rejestr npm, hooki Claude Code, wiersz poleceń npm/pnpm/Yarn/Bun/Deno, formy specyfikacji, rejestry z `.npmrc` i ich nadpisania; lista popularnych paczek (D-057).
- **Testy:**
  - nagrane odpowiedzi rejestru w `tests/fixtures/registry/` (`npm run record:registry`), bez sieci;
  - testy semver, specyfikacji, podobnych nazw, skanera i CLI.
- **Poprawki skanera i hooka:** zob. D-059.
- **Podobne nazwy:** bez porównania nazw z pominięciem scope'u (13% fałszywych alarmów, D-057).
- **Wydanie:** 1.1.0 (F1).

## 2026-10-29 · Luki w `doctor`, symlinki, edycja plików i zgodność `apply` z `doctor`

- **Model zagrożeń (D-052):** repozytorium to dane niezaufane; zainstalowana paczka działa na Node 22.0, 22 i 24.
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
- **Strażnik instalacji (`check`, hook):** zakres w D-053.

## 2026-10-29 · Bezpieczna publikacja

- **Workflow wydania** `.github/workflows/release.yml`: z tagu `vX.Y.Z` przez trusted publishing (OIDC) z proweniencją, bez tokenu npm. Wykonuje tylko `npm stage publish`, a wersja staje się publiczna po zatwierdzeniu z 2FA. Przed etapowaniem uruchamia wszystkie testy i `depcurfew doctor` na sobie (D-046).
- **`docs/RELEASING.md`:** jednorazowa ręczna konfiguracja (2FA, utworzenie paczki przez etapowanie i odrzucenie wersji próbnej, `npm trust github --allow-stage-publish`, zakaz tokenów, wydanie w ciągu 2 dni) oraz kroki każdego wydania ze sprawdzeniem proweniencji.
- **depcurfew stosuje własną politykę:** `depcurfew.json`, blok w `.npmrc` z `depcurfew apply` i `packageManager: npm@11.19.1`. `doctor` na sobie kończy się kodem 0 z jednym ostrzeżeniem (`fsevents`), czego pilnuje test (D-047).
- **Wersja 1.0.0** w `package.json`.
- **`lockfile-install-scripts`** uwzględnia wyłącznik wszystkich skryptów (np. `ignore-scripts=true`, D-048).
- **Baza wiedzy:** fakty o trusted publishing, publikacji etapowej i `npm trust` (D-049).
- **Kryterium wydania:** 1.0.0 ma proweniencję, co wymaga ręcznych kroków z `docs/RELEASING.md` (D-050).

## 2026-10-29 · GitHub Action i README

- **GitHub Action** (`action.yml`, D-040): uruchamia `doctor`, wysyła SARIF do code scanning i kończy zadanie błędem przy błędach `doctor`. Działa z własnego checkoutu przez zatwierdzony bundel `action/depcurfew.mjs` z dołączonym `yaml`. Test i CI pilnują, że bundel jest identyczny ze świeżym buildem (D-041).
- **Przypięcie do SHA:** wszystkie akcje (`actions/checkout`, `actions/setup-node`, `github/codeql-action/upload-sarif`) są przypięte do pełnych SHA, czego pilnuje test (D-042).
- **Workflow:** `ci.yml` (Node 22 i 24) i `action-test.yml`, czyli test akcji na samym depcurfew i na fiksturach, z prawdziwą wysyłką SARIF i instalacją Node 22 na runnerze z Node 20 (D-044).
- **README:** start w 5 minut, polecenia, polityka, tabela narzędzi z bazy wiedzy z datą `verifiedAt`, opis każdej reguły `doctor` i użycie Action. Sekcje z faktami generuje `npm run docs:readme`, a test pilnuje, że proza nie podaje nazw ustawień spoza tych sekcji (D-043).
- **Baza wiedzy:** fakt o wysyłce SARIF (akcja, wejścia, uprawnienia) w dziale „środowisko”.

## 2026-10-29 · `depcurfew doctor`

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
- `pnpm-shared-workspace-lockfile`: `shared-workspace-lockfile=false` w pnpm 10 nie ma oficjalnego potwierdzenia, że „unieważnia opóźnienie”. Reguła zgłasza `.npmrc` pakietu, który w tym trybie nadpisuje ustawienia workspace'u, co wynika z kodu pnpm (D-036).
- `config-drift` ostrzega też o wpisach w allowlistach narzędzi spoza polityki, których `apply` celowo nie usuwa.
- Baza wiedzy: 9 nowych faktów (formaty plików blokad, `.npmrc` w npm i pnpm 10) i 7 ustrukturyzowanych form istniejących faktów, wszystkie ze źródłami (D-037).
- Testy:
  - fikstury „uruchamia się” i „nie uruchamia się” dla każdej reguły (D-038);
  - raport SARIF każdej fikstury przechodzi walidację oficjalnym schematem OASIS (własny walidator, bez nowych zależności);
  - po `apply` na wszystkich 18 fiksturach repozytoriów `config-drift` nie zgłasza błędów;
  - CLI w procesie i e2e.

## 2026-10-28 · Generatory konfiguracji

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
- Testy:
  - 18 fikstur repozytoriów z oczekiwanym wynikiem w `expected/<nazwa>/after/` i raportem `apply.json`, w tym 4 nowe (D-032);
  - każda fikstura sprawdza wynik, brak utraty niezarządzanych ustawień i idempotencję (drugie `apply` nie zmienia żadnego pliku);
  - testy edytorów INI, TOML, YAML, JSONC, stylu tekstu i diffu;
  - CLI: `--dry-run` z nałożeniem diffu na pliki, brak i błąd polityki, zepsuty plik, symlink, opóźnienie botów po zaokrągleniu przez npm;
  - e2e na zbudowanym `dist/cli.js`.

## 2026-10-28 · Wykrywanie projektu

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
- Testy:
  - 14 fikstur repozytoriów z oczekiwanym `detect.json`;
  - przypadki brzegowe: zepsuty JSON i YAML, zły `packageManager`, za duży plik, symlinki poza repozytorium, wzorce workspace'ów z `..`, `**` bez `node_modules`, wyrażenia w workflow;
  - `explain` w procesie i e2e;
  - walidacja działu „środowisko”.

## 2026-10-28 · Plik polityki i walidacja

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
- Baza wiedzy: dwa nowe fakty, Renovate `extra.durationUnits` i Dependabot `extra.maximumDays`, ustalone w plikach źródłowych dokumentacji, bo strony z dokumentacją były niedostępne z sieci (D-020).
- Testy:
  - 21 fikstur polityk w `tests/fixtures/policies/` (wejście i oczekiwany wynik albo oczekiwane komunikaty);
  - przeliczenia każdej jednostki na granicach oraz wszystkich wartości 1–20 000 minut, które sprawdzają, że wynik nigdy nie daje krótszego opóźnienia;
  - jednostki sporne i brakujące na syntetycznej bazie;
  - zgodność `schema.json` z walidatorem;
  - `init` w procesie i e2e.

## 2026-10-28 · Baza wiedzy o menedżerach paczek

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
- Testy:
  - walidator na celowo zepsutych wpisach;
  - renderer na syntetycznej bazie;
  - prawdziwa baza: komplet narzędzi i faktów, zero błędów walidacji, `docs/knowledge.md` zgodny z bazą.
- Najważniejsze fakty:
  - npm 12 jest wydany (12.0.0, 2026-07-08): domyślnie blokuje skrypty zależności, a `allow-git`/`allow-remote` mają domyślnie `none`;
  - pnpm 12 jest bieżącą wersją główną. pnpm 11 usunął `onlyBuiltDependencies` na rzecz `allowBuilds` i nie czyta już ustawień innych niż uwierzytelnianie i rejestr z `.npmrc`;
  - Yarn ma od 4.14.0 skrypty domyślnie wyłączone, a `npmMinimalAgeGate` od 4.15.0 domyślnie `1d`. Migracja lockfile'a w starych projektach wpisuje łagodniejsze wartości;
  - Bun od 1.4.4 przyjmuje jednostki czasu, a `trustedDependencies` zastępuje wbudowaną listę zaufanych paczek;
  - Deno od 2.9.0 ma domyślne opóźnienie 24 h (liczba oznacza minuty);
  - Dependabot od 2026-07-14 ma domyślny cooldown 3 dni, a Renovate ma flagę CLI `--minimum-release-age`.

## 2026-10-28 · Szkielet repozytorium

- Dodano szkielet CLI w TypeScript, tylko ESM:
  - `src/cli.ts` (shebang, `process.exitCode` bez top-level await);
  - `src/cli/run.ts` (`util.parseArgs`, kody wyjścia 0/1/2);
  - pomoc z poleceniami `init`, `apply`, `doctor` i `explain` oznaczonymi jako „planned”;
  - `--version` czyta wersję z `package.json`.
- Narzędzia: tsdown 0.22.14, Vitest 4.1.12, TypeScript 6.0.3 (`tsc --noEmit`), publint 0.3.25, @arethetypeswrong/cli 0.18.5 (profil `esm-only`). Zależności w czasie działania: brak.
- Testy:
  - CLI w procesie;
  - e2e na zbudowanym `dist/cli.js` (shebang, `--help`, `--version`, kod 2);
  - kształt `package.json` (ESM-only, w `dependencies` tylko `yaml`, MIT);
  - skaner ESM na parserze TypeScript (brak top-level await i CommonJS w `src/` i `scripts/`);
  - wymuszona blokada sieci w testach.
- Higiena repozytorium: `.npmrc` z `save-exact`, `ignore-scripts` i `min-release-age=7`, `.gitattributes` z LF, `.gitignore` (z `docs/PLAN.md`, bo plan jest lokalny), licencja MIT (posiadacz praw: DevXord).
- Ręcznie wybrano vitest 4.1.12 z poprawką GHSA-qxg6-89mg-rqv8 i GHSA-xp26-3454-mjgp (D-008).
- `CLAUDE.md` z zasadami projektu, m.in.: zgoda na zależności, zakaz publikacji i push bez zgody, lokalny `docs/PLAN.md`, Node ≥ 22.18 do pracy.
