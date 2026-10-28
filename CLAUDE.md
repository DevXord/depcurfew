# Zasady projektu

## Cel
CLI, które z jednego pliku polityki generuje konfigurację bezpieczeństwa łańcucha dostaw dla npm, pnpm, Yarn, Bun, Deno, Renovate i Dependabota oraz wykrywa konfigurację, która po cichu nie działa.

## Twarde reguły
- To narzędzie bezpieczeństwa. Minimum zależności w czasie działania: wolno użyć wyłącznie `yaml` (zero zależności przechodnich), wszystko inne piszemy sami. Każda nowa zależność wymaga uzasadnienia w docs/decisions.md.
- Każda zależność poza `yaml`, także deweloperska, wymaga wcześniejszej zgody właściciela repozytorium.
- Wszystkie fakty o menedżerach paczek (nazwy opcji, pliki, jednostki, wersje, wartości domyślne) żyją wyłącznie w src/knowledge/. Każdy wpis ma `source` (URL oficjalnej dokumentacji lub changelogu) i `verifiedAt` (data). Testy pilnują, że żaden wpis nie ma pustego źródła.
- Nigdy nie wpisuj faktu o menedżerze paczek z pamięci. Sprawdź w aktualnej dokumentacji (WebFetch/WebSearch) i dopisz źródło.
- Przeliczanie jednostek zaokrągla zawsze w stronę dłuższego opóźnienia.
- Edycja cudzych plików konfiguracyjnych jest idempotentna, zachowuje komentarze i formatowanie, a zarządzane fragmenty oznacza znacznikami. Drugie `apply` bez zmian polityki nie zmienia żadnego pliku.
- `apply` nigdy nie usuwa ustawień, których nie zarządza.
- Testy nie korzystają z sieci; fikstury repozytoriów leżą w tests/fixtures.
- Tylko ESM, bez top-level await.
- Nie publikuj niczego na npm, nie twórz kont i nie wypychaj zmian do zdalnego repozytorium bez zgody właściciela. Nie zmieniaj ustawień poza tym repozytorium.
- docs/PLAN.md jest dokumentem lokalnym (jest w .gitignore) i nigdy nie trafia do commitów.

## Polecenia
- `npm test` – build (tsdown) i testy (Vitest), w tym testy fikstur „przed i po”
- `npm run build` – build przez tsdown
- `npm run typecheck` – sprawdzenie typów (tsc, bez emisji)
- `npm run check:pkg` – publint i @arethetypeswrong/cli
- `npm run docs:knowledge` – generuje docs/knowledge.md z src/knowledge/
- `npm run schema` – generuje schema.json z definicji polityki w src/policy/schema.ts
- `node dist/cli.js doctor tests/fixtures/<nazwa>` – ręczne sprawdzenie na fiksturze

## Środowisko
- Praca nad repozytorium wymaga Node ≥ 22.18: skrypty w scripts/ uruchamiamy natywnie z plików `.ts` (type stripping), a importy względne mają końcówkę `.ts`.
- Użytkownicy CLI potrzebują Node zgodnego z `engines` w package.json.

## Sposób pracy
- Jedna faza planu na sesję. Na początku sesji przeczytaj docs/PLAN.md i docs/decisions.md.
- Najpierw testy (fikstura wejściowa i oczekiwany wynik), potem implementacja.
- Po każdej fazie: krótkie podsumowanie w docs/CHANGELOG-dev.md i commit.
