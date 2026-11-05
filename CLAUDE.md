# Zasady projektu

## Cel
CLI, które z jednego pliku polityki generuje konfigurację bezpieczeństwa łańcucha dostaw dla npm, pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Composera, Bundlera (Ruby), Renovate i Dependabota oraz wykrywa konfigurację, która po cichu nie działa.

## Twarde reguły
- To narzędzie bezpieczeństwa. Minimum zależności w czasie działania: wolno użyć wyłącznie `yaml` (zero zależności przechodnich), wszystko inne piszemy sami. Każda nowa zależność wymaga uzasadnienia w decisions.md (dokument wewnętrzny).
- Każda zależność poza `yaml`, także deweloperska, wymaga wcześniejszej zgody właściciela repozytorium.
- Wszystkie fakty o menedżerach paczek (nazwy opcji, pliki, jednostki, wersje, wartości domyślne) żyją wyłącznie w src/knowledge/. Każdy wpis ma `source` (URL oficjalnej dokumentacji lub changelogu) i `verifiedAt` (data). Testy pilnują, że żaden wpis nie ma pustego źródła.
- Nigdy nie wpisuj faktu o menedżerze paczek z pamięci. Sprawdź w aktualnej dokumentacji (WebFetch/WebSearch) i dopisz źródło.
- Przeliczanie jednostek zaokrągla zawsze w stronę dłuższego opóźnienia.
- Edycja cudzych plików konfiguracyjnych jest idempotentna, zachowuje komentarze i formatowanie, a zarządzane fragmenty oznacza znacznikami. Drugie `apply` bez zmian polityki nie zmienia żadnego pliku.
- `apply` nigdy nie usuwa ustawień, których nie zarządza.
- Testy nie korzystają z sieci; fikstury repozytoriów leżą w tests/fixtures.
- Tylko ESM, bez top-level await.
- Nie publikuj niczego na npm, nie twórz kont i nie wypychaj zmian do zdalnego repozytorium bez zgody właściciela. Nie zmieniaj ustawień poza tym repozytorium.

## Internal documents
- PLAN.md (plan, strategia, ceny i wersja płatna), decisions.md (dziennik decyzji D-NNN) i CHANGELOG-dev.md (dziennik faz i sesji) to dokumenty wewnętrzne. Opiekun trzyma je poza repozytorium i poza jego katalogiem roboczym.
- Nigdy nie są śledzone, commitowane ani wypychane; `.gitignore` wymienia je jako zabezpieczenie.
- Teksty publiczne (README, CHANGELOG, CONTRIBUTING, SECURITY, dokumentacja w docs/, szablony GitHuba, dokumentacja paczki i strony) ich nie wymieniają i do nich nie linkują; pilnuje tego test `tests/meta/internal-docs.test.ts`. Identyfikatory decyzji (D-NNN) w komentarzach kodu zostają.
- W sesji w chmurze opiekun przesyła je na początku. Sesja trzyma je poza repozytorium (np. w katalogu na notatki), dopisuje w nich decyzje i wpisy, a na końcu oddaje zmienione pliki jako .zip (bez katalogu docs/ w środku) i ich nie commituje.
- Bez nich sesja pyta o nie, zanim zacznie pracę, która wymaga planu, decyzji albo faktu z tych dokumentów.

## Komunikaty (dla człowieka i dla AI)
- Każdy błąd i ostrzeżenie mówi, co jest nie tak, gdzie (plik i linia, gdy są znane) i co zrobić (`fix` w `doctor`, wskazówka w `apply` i `check`). Prosty angielski, nazwy plików i ustawień dosłownie.
- Kolor tylko w terminalu (TTY), z obsługą `NO_COLOR` i `FORCE_COLOR`. Kolor nigdy nie jest jedynym nośnikiem informacji: poziom (`error`, `warning`, `note`) zawsze stoi słowem.
- Każde polecenie, które coś zgłasza, ma wyjście maszynowe (`--json`, w `doctor` także `--sarif`) ze stałym schematem: `schemaVersion`, identyfikator reguły lub kodu, poziom, położenie, `message` i `fix`. Na stdout tylko JSON, bez kolorów, także przy błędnej polityce. Zmiana niezgodna wstecz (usunięte pole albo inne znaczenie) to nowa wersja `schemaVersion`; nowe pola, wartości i reguły dopisujemy bez zmiany wersji. Kody ostrzeżeń i błędów `apply` są w `src/apply/warnings.ts` i w README.
- Tekst i JSON mają jedno źródło komunikatu, różnią się tylko formatem. Kody wyjścia są opisane w `--help` i nie zmieniają znaczenia.
- Nowy komunikat przechodzi ten sam test, zanim trafi do kodu.

## Polecenia
- `npm test` – build (tsdown) i testy (Vitest), w tym testy fikstur „przed i po”
- `npm run build` – build przez tsdown
- `npm run typecheck` – sprawdzenie typów (tsc, bez emisji)
- `npm run check:pkg` – publint i @arethetypeswrong/cli
- `npm run docs:knowledge` – generuje docs/knowledge.md z src/knowledge/
- `npm run docs:readme` – przepisuje wygenerowane sekcje README.md (baza wiedzy, polityka, reguły `doctor`, `action.yml`)
- `npm run build:action` – buduje action/depcurfew.mjs dla GitHub Action; zatwierdzany w repozytorium, musi być zgodny ze źródłem
- `npm run schema` – generuje schema.json z definicji polityki w src/policy/schema.ts
- `npm run site` – buduje stronę dokumentacji w dist-site/ (poza gitem) z README.md, src/knowledge/ i schema.json; z `-- --versions` także dokumentację wcześniejszych wydań z tagów git. Stronę https://depcurfew.github.io wdraża workflow repozytorium depcurfew/depcurfew.github.io (jego pliki są w site/org-repo/)
- `node dist/cli.js explain tests/fixtures/repos/<nazwa>` – ręczne sprawdzenie wykrywania na fiksturze
- `node dist/cli.js doctor tests/fixtures/doctor/<reguła>/<przypadek>/repo` – ręczne sprawdzenie reguły `doctor` na fiksturze (`--json`, `--sarif`)
- `node dist/cli.js apply --dry-run <katalog>` – podgląd zmian `apply` bez zapisu (katalog musi mieć `depcurfew.json`)
- `node dist/cli.js check <paczka>` – ręczne sprawdzenie paczki w prawdziwym rejestrze npm, `pypi:<paczka>` na PyPI, a `composer:<vendor>/<paczka>` w Packagist; z `--osv` także w OSV.dev (wymaga sieci; testy jej nie używają)
- `npm run data:popular` – odświeża listę popularnych paczek npm w src/knowledge/popular.ts; z `-- pypi` listę projektów PyPI w src/knowledge/popular-python.ts (wymaga sieci)
- `npm run record:registry` – nagrywa na nowo odpowiedzi rejestru npm, PyPI i Packagist oraz OSV.dev dla testów `check` i `--osv` w tests/fixtures/registry, tests/fixtures/pypi, tests/fixtures/packagist i tests/fixtures/osv; `-- npm`, `-- pypi`, `-- packagist` albo `-- osv` tylko jeden z nich (wymaga sieci)

## Środowisko
- Praca nad repozytorium wymaga Node ≥ 22.18: skrypty w scripts/ uruchamiamy natywnie z plików `.ts` (type stripping), a importy względne mają końcówkę `.ts`.
- Użytkownicy CLI potrzebują Node zgodnego z `engines` w package.json.

## Sposób pracy
- Jedna faza planu na sesję. Na początku sesji przeczytaj PLAN.md i decisions.md (dokumenty wewnętrzne, zob. „Internal documents”).
- Najpierw testy (fikstura wejściowa i oczekiwany wynik), potem implementacja.
- Po każdej fazie: krótkie podsumowanie w CHANGELOG-dev.md (dokument wewnętrzny, poza commitem) i commit zmian w repozytorium.
- Projekty testowe do ręcznych testów (poza tests/fixtures) usuwamy po teście; zostaje tylko zapis konsoli. Testy automatyczne też sprzątają po sobie, również uruchomione z filtrem `-t`.
