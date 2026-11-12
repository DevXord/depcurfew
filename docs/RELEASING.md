# Wydawanie depcurfew

Wydanie powstaje w GitHub Actions z tagu `vX.Y.Z` przez trusted publishing (OIDC), bez tokenu npm w sekretach, i dostaje proweniencję. Workflow nie publikuje wprost: tylko etapuje wersję (`npm stage publish`), a wersja staje się publiczna dopiero, gdy właściciel zatwierdzi ją z 2FA.

Fakty o npm, na których opiera się ta procedura (wymagane wersje, zachowanie etapowania, wygasanie konfiguracji), są w bazie wiedzy: `trustedPublishing`, `stagedPublishing`, `stageReview` i `trustCommand` w `src/knowledge/npm.ts`, ze źródłami w [docs/knowledge.md](knowledge.md).

## Jak działa workflow

`.github/workflows/release.yml` uruchamia się po wypchnięciu tagu `vX.Y.Z`:

1. Ma cztery joby, a akcje są przypięte do pełnych SHA. Tylko `stage` może poprosić o token OIDC i rusza dopiero, gdy przejdą trzy pozostałe.
2. **`build`** (tylko `contents: read`, limit 30 minut) na Node 24 z npm 11.19.1 sprawdza, że tag zgadza się z wersją w `package.json`, że oznaczony commit jest w `main` (tag postawiony na innej gałęzi zatrzymuje workflow) i że pierwsza sekcja `## ` w `CHANGELOG.md` to `## X.Y.Z`, bo z niej powstaje opis wydania. Uruchamia `npm ci` (bez skryptów zależności), `npm test`, `typecheck`, `check:pkg`, zgodność bundla akcji i `depcurfew doctor` na samym repozytorium. Na końcu `npm pack` zapisuje paczkę `depcurfew-X.Y.Z.tgz`, a `actions/upload-artifact` dołącza ją do przebiegu; nazwa pliku, jego `shasum` (SHA-1) i `integrity` (SHA-512) są wyjściami joba.
3. **`rebuild`** (tylko `contents: read`, limit 15 minut, po `build`) buduje paczkę od nowa ze świeżego checkoutu tagu na innym runnerze, tymi samymi poleceniami co workflow „Verify release” (Node 24 bez cache, npm 11.19.1, `npm ci`, `npm run build`, `npm pack`), i porównuje `integrity` z jobem `build`. Przy różnicy pobiera paczkę z `build`, rozpakowuje obie i nazywa pliki, które się różnią. Żaden krok joba `build` (testy, publint, attw) nie zmieni więc paczki niezauważenie, a build, który nie daje za każdym razem tego samego pliku (jak 1.5.0), zatrzymuje wydanie przed etapem.
4. **`ci-passed`** (tylko `actions: read`, limit 25 minut, bez checkoutu i bez kodu repozytorium) czeka, aż na oznaczonym commicie przejdą `ci.yml` (Linux i Windows, Node 22, 24 i 26, najstarszy Node z `engines`) i `action-test.yml`, których `build` nie powtarza. Liczą się przebiegi `push` (scalenie do `main` i sam tag) i uruchomione ręcznie (`workflow_dispatch`), a wystarcza pierwszy udany. Job pyta co 30 s i po 20 minutach się poddaje; pada od razu, gdy wszystkie przebiegi tego commitu skończyły się bez sukcesu.
5. **`stage`** (tylko `id-token: write`, limit 10 minut, bez checkoutu, po `build`, `rebuild` i `ci-passed`) sprawdza, że npm ma co najmniej 11.15.0 (etapowanie z trusted publishing), pobiera plik przez `actions/download-artifact` i porównuje jego SHA-512 z `integrity` z joba `build` i z `rebuild`. Nie uruchamia kodu repozytorium ani zależności.
6. `stage` wykonuje `npm stage publish ./depcurfew-X.Y.Z.tgz --provenance`. Dla gotowego pliku npm nie uruchamia żadnego skryptu. npm uwierzytelnia się przez OIDC, a proweniencja powstaje, bo repozytorium i paczka są publiczne. Na końcu podsumowanie przebiegu (strona przebiegu w zakładce Actions) podaje nazwę pliku, jego `shasum` i `integrity` oraz to, co porównuje zatwierdzający (krok 4 w „Każde wydanie”).

## Jednorazowa konfiguracja (po stronie właściciela)

Kroki 2–4 trzeba wykonać jeden po drugim, a po kroku 3 w ciągu 2 dni wydać pierwszą wersję. Nowa konfiguracja trusted publishera wygasa, jeśli w tym czasie nie przejdzie przez nią udana publikacja.

1. **Konto npm z 2FA i lokalny npm 11.15.0 lub nowszy.** Sprawdź `npm --version`.
   - Node 24 LTS ma npm 11.19.1.
   - Najnowszy npm 12 nie działa na Node 25, więc tam trzeba zainstalować `npm install -g npm@11`.
   - Pracuj w świeżym klonie: `node -p "require('./package.json').name"` musi pokazać `depcurfew`.

2. **Utworzenie paczki bez publikowania kodu.** Trusted publishera można skonfigurować tylko dla istniejącej paczki. Etapowanie nowej paczki tworzy ją z publiczną wersją zastępczą `0.0.0-stage`, a wersja próbna nie trafia do publicznego rejestru, dopóki czeka na zatwierdzenie. W czystym klonie:

   ```bash
   npm login
   npm ci
   npm run build
   npm version 0.0.2-bootstrap.0 --no-git-tag-version
   npm stage publish --tag bootstrap
   git checkout -- package.json package-lock.json
   ```

   **Etapu próbnego nie odrzucaj przed pierwszym wydaniem.** Odrzucenie jedynego etapu wycofuje też wersję zastępczą. Paczka wtedy znika, a npm blokuje jej nazwę na 24 godziny i nie da się skonfigurować trusted publishera. Tak było 2026-10-29: etap `0.0.1-bootstrap.0` odrzucony o 21:41 UTC wycofał `0.0.0-stage`. Etap próbny odrzuć dopiero po pierwszym wydaniu (krok 8 w „Każde wydanie”).

3. **Trusted publisher z prawem tylko do etapowania** (bez `--allow-publish`):

   ```bash
   npm trust github depcurfew --file release.yml --repo DevXord/depcurfew --allow-stage-publish
   ```

   To samo można zrobić na npmjs.com: paczka → **Settings** → **Trusted Publisher** → GitHub Actions; użytkownik `DevXord`, repozytorium `depcurfew`, plik workflow `release.yml`, bez środowiska, dozwolone tylko `npm stage publish`. npm nie sprawdza konfiguracji przy zapisie, więc literówka wyjdzie dopiero przy publikacji.

4. **Wyłączenie publikacji tokenami:** paczka → **Settings** → **Publishing access** → „Require two-factor authentication and disallow tokens” → **Update Package Settings**. Trusted publishing działa dalej, bo nie używa tokenów.

5. **Paczka w organizacji npm `depcurfew`.** Nazwa zostaje bez zakresu, żeby działało `npx depcurfew`. Organizacja nie może przejąć takiej paczki na własność, więc właścicielem zostaje konto, które ją utworzyło. Organizacja zarządza nią przez zespół `developers`, do którego należą wszyscy jej członkowie, także właściciel. Przyznaj temu zespołowi prawo zapisu w jeden z dwóch sposobów:
   - na npmjs.com: organizacja `depcurfew` → **Teams** → przy zespole `developers` **Packages** → w polu „Package” wpisz `depcurfew` → **+ Add Existing Package** → **read/write**;
   - z wiersza poleceń, z 2FA:

     ```bash
     npm access grant read-write depcurfew:developers depcurfew
     ```

   Paczka pojawi się wtedy w zakładce **Packages** organizacji. Prawo zapisu wystarcza, żeby etapować i zatwierdzać wersje (z 2FA), więc do organizacji dodawaj tylko zaufane osoby. Zalecane: organizacja → **Members** → **Enable 2FA Enforcement**, żeby nikt bez 2FA nie był jej członkiem.

   Źródła (dokumentacja npm, stan z 2026-10-29): [paczki bez zakresu w organizacji](https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/organizations/managing-organization-packages/about-organization-scopes-and-packages.mdx), [dostęp zespołu do paczki](https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/organizations/managing-teams/managing-team-access-to-organization-packages.mdx), [zespół `developers`](https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/organizations/managing-teams/about-developers-team.mdx), [brak przeniesienia paczki na organizację](https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/packages-and-modules/introduction-to-packages-and-modules/package-scope-access-level-and-visibility.mdx), [2FA w organizacji](https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/organizations/creating-and-managing-organizations/requiring-two-factor-authentication-in-your-organization.mdx).

6. **Zalecane:** w ustawieniach repozytorium GitHub reguła, która pozwala tworzyć tagi `v*` tylko właścicielowi, żeby nikt inny nie mógł uruchomić workflow wydania.

7. **Strona dokumentacji https://depcurfew.github.io/** (repozytorium organizacji `depcurfew/depcurfew.github.io`). Repozytorium już istnieje: publikuje stronę z gałęzi (**Deploy from a branch**), a gałąź ma zbudowaną stronę (wygenerowane pliki HTML, `style.css`, `favicon.svg`, `schema.json`, `schema/`, katalogi wcześniejszych wersji), plik `.nojekyll` i README, które mówi, że wszystko jest wygenerowane. Przejście na workflow robi się raz, **dopiero gdy GitHub Release `v1.4.0` jest opublikowany**: workflow buduje najnowsze opublikowane wydanie, a `npm run site` ma dopiero 1.4.0, więc przy starszym wydaniu kończy się błędem `::error::` z nazwą wydania i nic nie wdraża. Kolejno:
   - w klonie `depcurfew/depcurfew.github.io` usuń całą zawartość gałęzi domyślnej oprócz `.git`: wszystkie wygenerowane pliki i katalogi, `.nojekyll` i stare `README.md` (`git rm -r .` usuwa też pliki zaczynające się kropką);
   - skopiuj do niego pliki z `site/org-repo/` tego repozytorium z tymi samymi ścieżkami: `README.md` i `.github/workflows/pages.yml`; sprawdź, że `git status` pokazuje tylko te dwa pliki jako dodane, i wypchnij commit na gałąź domyślną;
   - w nim **Settings** → **Pages** → **Build and deployment** → **Source**: zmień „Deploy from a branch” na „GitHub Actions”; środowisko `github-pages` może mieć regułę tylko dla gałęzi domyślnej, bo workflow działa na niej (harmonogram zawsze, ręczne uruchomienie z `main`);
   - pierwsze wdrożenie od razu ręcznie: **Actions** → „Pages” → **Run workflow**; do jego końca strona pokazuje ostatnie wdrożenie z gałęzi, potem stronę zbudowaną z `v1.4.0` z wcześniejszymi wersjami pod `/<wersja>/`;
   - jeśli w tym repozytorium włączono kiedyś Pages, wyłącz tu stronę projektu (**Settings** → **Pages** → menu przy „Your site is live at” → **Unpublish site**), żeby dokumentacja nie miała drugiej kopii;
   - repozytorium główne to `DevXord/depcurfew`; gdy zmieni adres, zmień `SOURCE_REPOSITORY` w `.github/workflows/pages.yml` repozytorium organizacji i w `site/org-repo/` oraz pole `repository` w `package.json`;
   - GitHub wyłącza zaplanowany workflow publicznego repozytorium po 60 dniach bez aktywności w nim; wtedy włącz go w **Actions** albo uruchom ręcznie.

## Każde wydanie

1. **Wersja.** Na gałęzi podnieś wersję (`npm version X.Y.Z --no-git-tag-version`; `package.json` i oba pola wersji w `package-lock.json` muszą się zgadzać, co sprawdza test), dopisz zmiany dla użytkowników po angielsku do `CHANGELOG.md`, scal PR do `main`. Między wydaniami zmiany czekają w sekcji `## Unreleased` (test przyjmuje jako pierwszą sekcję tylko ją albo wersję z `package.json`); PR wydania zmienia jej nagłówek na `## X.Y.Z`, bo workflow Release tego wymaga. Tag stawiaj dopiero wtedy, gdy PR wydania jest scalony do `main`: workflow buduje i publikuje to, co jest w oznaczonym commicie. 2026-10-31 tag `v1.0.0` trafił na `main` przed scaleniem `faza-7`, więc 1.0.0 wyszła ze starszego kodu, a pełna wersja dostała numer 1.1.0.
2. **Tag na commicie z `main`:**

   ```bash
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   Tag można postawić od razu po scaleniu: job `ci-passed` czeka (do 20 minut), aż CI na tym commicie się skończy.
3. **Workflow „Release”** w zakładce Actions sprawdza wszystko i etapuje paczkę. Jeśli któryś krok się nie uda, nic nie trafia do npm, a komunikat `::error::` mówi, co zrobić:
   - **Czerwone CI na oznaczonym commicie** (pada `ci-passed`): w przebiegu CI albo Action test tego commitu **Re-run failed jobs** (albo uruchom workflow ręcznie na tagu: **Actions** → „CI” → **Run workflow** → tag `vX.Y.Z`), a gdy przejdzie, w przebiegu Release **Re-run failed jobs**. Joby `build` i `rebuild` nie są powtarzane: ich wyjścia zostają z pierwszej próby.
   - **Różnica w `rebuild`, brak sekcji w `CHANGELOG.md` albo błąd okablowania** (puste wyjście joba, inna nazwa pliku, literówka w workflow): nie uruchamiaj niczego ponownie, bo powtórka może przepuścić build, który nie daje za każdym razem tego samego pliku. Popraw przyczynę w PR-ze do `main`, usuń tag (`git push origin :refs/tags/vX.Y.Z` i `git tag -d vX.Y.Z`) i postaw go ponownie na nowym commicie scalenia. Nic nie zostało zaetapowane.
   - **Przejściowy błąd** (rejestr npm, sieć runnera, API GitHuba): tylko wtedy wystarczy **Re-run failed jobs** samego przebiegu Release. Gdy nie uda się tylko job `stage`, etapuje on ten sam plik z joba `build`.
4. **Przegląd etapowanej wersji:**

   ```bash
   npm stage list depcurfew
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

   Zatwierdzający porównuje sumy z podsumowaniem przebiegu Release (nazwa pliku, `shasum` i `integrity` z joba `stage`). `npm stage list depcurfew` podaje identyfikator etapu (jest też w logu kroku, który etapuje), `npm stage view <stage-id>` pokazuje `shasum` etapowanego pliku, a `npm stage download <stage-id>` zapisuje `depcurfew-X.Y.Z-<stage-id>.tgz` w bieżącym katalogu i wypisuje `shasum` pobranych bajtów (z `--json` także całe `integrity`). Każda z tych sum musi być równa tej z podsumowania; inaczej nie zatwierdzaj i odrzuć etap (`npm stage reject <stage-id>`). Ten sam plik zbudował już od nowa job `rebuild`, a po publikacji workflow „Verify release” porówna go z buildem tagu.
5. **Zatwierdzenie z 2FA:** na npmjs.com zakładka **Staged Packages** → **Approve**, albo `npm stage approve <stage-id>`.
6. **Sprawdzenie proweniencji:** strona paczki na npmjs.com pokazuje proweniencję (repozytorium, workflow, commit). W dowolnym projekcie po instalacji `depcurfew@X.Y.Z` polecenie `npm audit signatures` powinno wykazać zweryfikowaną attestację.
7. **Po wydaniu:**
   - w `src/docs/readme.ts` wpisać w `ACTION_RELEASE` wersję i pełny SHA commita wydania (`git rev-parse vX.Y.Z`), potem `npm run docs:readme` i PR do `main`; przykład Action w README przypina wtedy ten commit;
   - w tym samym PR-ze `VERIFIED_RELEASE` dostaje tę samą wersję co `ACTION_RELEASE`, ale dopiero gdy sprawdzenie po publikacji dało tę samą sumę dla tagu i dla rejestru: ręczny przebieg workflow „Verify release” z wejściem `version` albo polecenia z sekcji „Verifying a release” w README. Gdy sumy się różnią, wersja trafia do `UNVERIFIABLE_RELEASES`, `VERIFIED_RELEASE` zostaje przy poprzednim wydaniu, a README opisuje ręcznie, czym paczka różni się od buildu tagu (tak jak dla 1.5.0); test README pilnuje obu reguł;
   - `NPX_RELEASE` to najnowsze wydanie, które w dniu tego PR-u ma co najmniej 7 dni (zwykle poprzednie), nigdy nowsze niż `ACTION_RELEASE`: przykład `npx --yes depcurfew@<wersja>` w README musi przejść przez domyślne `cooldown.minimum`, hook depcurfew i `min-release-age` npm;
   - utworzyć na GitHubie Release `vX.Y.Z` z tagu, z sekcją wersji z `CHANGELOG.md` jako opisem;
   - https://depcurfew.github.io/ buduje się z gałęzi `main`, więc zmiany dokumentacji są na niej po najbliższym codziennym przebiegu workflow „Pages” w `depcurfew/depcurfew.github.io` albo od razu po jego ręcznym uruchomieniu (**Actions** → „Pages” → **Run workflow**), bez wydania; do wydania strony mają pasek, że opisują niewydaną wersję albo zmiany po wydaniu. Po tagu uruchomić „Pages”: pasek znika, a poprzednie wydanie trafia pod `/<wersja>/`;
   - poprzednią wersję z błędem, którego nie powinno się już instalować, oznaczyć `npm deprecate`.
8. **Tylko po pierwszym wydaniu:** odrzuć etap próbny z kroku 2 jednorazowej konfiguracji (`npm stage list depcurfew`, potem `npm stage reject <stage-id>`, z 2FA). Opublikowana wersja zostaje. Po 1.0.0 to już zrobione. README trafia do paczki w chwili publikacji i to ono jest na stronie npm, więc wszystko, co ma się tam znaleźć, musi być w `main` przed tagiem.

## Gdy coś nie działa

- **`ENEEDAUTH` przy etapowaniu:** nazwa pliku (`release.yml`), użytkownik i repozytorium muszą zgadzać się dokładnie z konfiguracją trusted publishera, wielkość liter też. Job `stage` musi mieć `id-token: write` i działać na runnerze hostowanym przez GitHub.
- **Inna suma pliku w jobie `stage`:** plik pobrany z artefaktu nie jest tym, który spakował job `build`, i nic nie zostało etapowane. Zanim uruchomisz cokolwiek ponownie, porównaj w logach obu jobów nazwę pliku i sumę `sha512-…`.
- **`E403` przy `npm access grant`:** paczka jeszcze nie istnieje w rejestrze (`npm view depcurfew` nic nie pokazuje). Najpierw wykonaj krok 2 jednorazowej konfiguracji; zespół dostaje dostęp tylko do istniejącej paczki. Tak było 2026-10-30: nazwa była jeszcze zablokowana po wycofaniu z 2026-10-29.
- **Konfiguracja wygasła** (brak udanej publikacji w 2 dni): usuń ją, utwórz nową i od razu wydaj wersję.
- **Brak proweniencji:** publikacja musi przejść przez OIDC z publicznego repozytorium, a paczka musi być publiczna.
- **Zły tag, wersja albo sekcja `CHANGELOG.md`:** workflow zatrzyma się na sprawdzeniu tagu albo sekcji. Usuń tag (`git push origin :refs/tags/vX.Y.Z` i `git tag -d vX.Y.Z`), popraw i wypchnij ponownie. Błędną etapowaną wersję odrzuć: `npm stage reject <stage-id>`.
- **Opublikowana wersja ma złą treść:** tego samego numeru nie da się użyć ponownie, nawet po `npm unpublish` (polityka npm: „Once `package@version` has been used, you can never use it again.”, [unpublish policy](https://github.com/npm/documentation/blob/28eb0ccc64dc/content/policies/unpublish.mdx)). Wydaj następną wersję, a starą oznacz: `npm deprecate depcurfew@X.Y.Z "<co zamiast>"` (z 2FA).
