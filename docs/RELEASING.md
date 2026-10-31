# Wydawanie depcurfew

Wydanie powstaje w GitHub Actions z tagu `vX.Y.Z` przez trusted publishing (OIDC), bez tokenu npm w sekretach, i dostaje proweniencję. Workflow nie publikuje wprost: tylko etapuje wersję (`npm stage publish`), a wersja staje się publiczna dopiero, gdy właściciel zatwierdzi ją z 2FA.

Fakty o npm, na których opiera się ta procedura (wymagane wersje, zachowanie etapowania, wygasanie konfiguracji), są w bazie wiedzy: `trustedPublishing`, `stagedPublishing` i `trustCommand` w `src/knowledge/npm.ts`, ze źródłami w [docs/knowledge.md](knowledge.md).

## Jak działa workflow

`.github/workflows/release.yml` uruchamia się po wypchnięciu tagu `vX.Y.Z`:

1. Ma tylko uprawnienia `contents: read` i `id-token: write`, a akcje są przypięte do pełnych SHA.
2. Na Node 24 sprawdza, że npm ma co najmniej 11.15.0 (etapowanie z trusted publishing), że tag zgadza się z wersją w `package.json` i że oznaczony commit jest w `main` (tag postawiony na innej gałęzi zatrzymuje workflow). Job ma limit 30 minut.
3. Uruchamia `npm ci` (bez skryptów zależności), `npm test`, `typecheck`, `check:pkg` i zgodność bundla akcji, a potem `depcurfew doctor` na samym repozytorium.
4. Wykonuje `npm stage publish --provenance`. npm uwierzytelnia się przez OIDC, a proweniencja powstaje, bo repozytorium i paczka są publiczne.

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

3. **Trusted publisher z prawem tylko do etapowania** (decyzja z fazy 8: bez `--allow-publish`):

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

## Każde wydanie

1. **Wersja.** Na gałęzi podnieś wersję (`npm version X.Y.Z --no-git-tag-version`), dopisz zmiany dla użytkowników po angielsku do `CHANGELOG.md` (i deweloperskie do `docs/CHANGELOG-dev.md`), scal PR do `main`. Tag stawiaj dopiero wtedy, gdy PR wydania jest scalony do `main`: workflow buduje i publikuje to, co jest w oznaczonym commicie. 2026-10-31 tag `v1.0.0` trafił na `main` przed scaleniem `faza-7`, więc 1.0.0 wyszła ze starszego kodu, a pełna wersja dostała numer 1.1.0.
2. **Tag na commicie z `main`:**

   ```bash
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. **Workflow „Release”** w zakładce Actions sprawdza wszystko i etapuje paczkę. Jeśli któryś krok się nie uda, nic nie trafia do npm.
4. **Przegląd etapowanej wersji:**

   ```bash
   npm stage list depcurfew
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

   Pobrany plik `.tgz` można porównać z `npm pack --dry-run` w checkoucie tagu.
5. **Zatwierdzenie z 2FA:** na npmjs.com zakładka **Staged Packages** → **Approve**, albo `npm stage approve <stage-id>`.
6. **Sprawdzenie proweniencji:** strona paczki na npmjs.com pokazuje proweniencję (repozytorium, workflow, commit). W dowolnym projekcie po instalacji `depcurfew@X.Y.Z` polecenie `npm audit signatures` powinno wykazać zweryfikowaną attestację.
7. **Po wydaniu** w README wpisać w przykładzie Action pełny SHA commita wydania i utworzyć na GitHubie Release `vX.Y.Z` z tagu, z sekcją wersji z `CHANGELOG.md` jako opisem.
8. **Tylko po pierwszym wydaniu:** odrzuć etap próbny z kroku 2 jednorazowej konfiguracji (`npm stage list depcurfew`, potem `npm stage reject <stage-id>`, z 2FA). Opublikowana wersja zostaje. Po 1.0.0 to już zrobione. README trafia do paczki w chwili publikacji i to ono jest na stronie npm, więc wszystko, co ma się tam znaleźć, musi być w `main` przed tagiem.

## Gdy coś nie działa

- **`ENEEDAUTH` przy etapowaniu:** nazwa pliku (`release.yml`), właściciel i repozytorium muszą zgadzać się dokładnie z konfiguracją trusted publishera, wielkość liter też. Workflow musi mieć `id-token: write` i działać na runnerze hostowanym przez GitHub.
- **`E403` przy `npm access grant`:** paczka jeszcze nie istnieje w rejestrze (`npm view depcurfew` nic nie pokazuje). Najpierw wykonaj krok 2 jednorazowej konfiguracji; zespół dostaje dostęp tylko do istniejącej paczki. Tak było 2026-10-30: nazwa była jeszcze zablokowana po wycofaniu z 2026-10-29.
- **Konfiguracja wygasła** (brak udanej publikacji w 2 dni): usuń ją, utwórz nową i od razu wydaj wersję.
- **Brak proweniencji:** publikacja musi przejść przez OIDC z publicznego repozytorium, a paczka musi być publiczna.
- **Zły tag albo wersja:** workflow zatrzyma się na sprawdzeniu tagu. Usuń tag (`git push origin :refs/tags/vX.Y.Z` i `git tag -d vX.Y.Z`), popraw i wypchnij ponownie. Błędną etapowaną wersję odrzuć: `npm stage reject <stage-id>`.
- **Opublikowana wersja ma złą treść:** tego samego numeru nie da się użyć ponownie, nawet po `npm unpublish` (polityka npm: „Once `package@version` has been used, you can never use it again.”, [unpublish policy](https://github.com/npm/documentation/blob/28eb0ccc64dc/content/policies/unpublish.mdx)). Wydaj następną wersję, a starą oznacz: `npm deprecate depcurfew@X.Y.Z "<co zamiast>"` (z 2FA).
