# Wydawanie depcurfew

Wydanie powstaje w GitHub Actions z tagu `vX.Y.Z` przez trusted publishing (OIDC), bez tokenu npm w sekretach, i dostaje proweniencję. Workflow nie publikuje wprost: tylko etapuje wersję (`npm stage publish`), a wersja staje się publiczna dopiero, gdy właściciel zatwierdzi ją z 2FA.

Fakty o npm, na których opiera się ta procedura (wymagane wersje, zachowanie etapowania, wygasanie konfiguracji), są w bazie wiedzy: `trustedPublishing`, `stagedPublishing` i `trustCommand` w `src/knowledge/npm.ts`, ze źródłami w [docs/knowledge.md](knowledge.md).

## Jak działa workflow

`.github/workflows/release.yml` uruchamia się po wypchnięciu tagu `vX.Y.Z`:

1. Ma tylko uprawnienia `contents: read` i `id-token: write`, a akcje są przypięte do pełnych SHA.
2. Na Node 24 sprawdza, że npm ma co najmniej 11.15.0 (etapowanie z trusted publishing) i że tag zgadza się z wersją w `package.json`.
3. Uruchamia `npm ci` (bez skryptów zależności), `npm test`, `typecheck`, `check:pkg` i zgodność bundla akcji, a potem `depcurfew doctor` na samym repozytorium.
4. Wykonuje `npm stage publish --provenance`. npm uwierzytelnia się przez OIDC, a proweniencja powstaje, bo repozytorium i paczka są publiczne.

## Jednorazowa konfiguracja (po stronie właściciela)

Kroki 2–4 trzeba wykonać jeden po drugim, a po kroku 3 w ciągu 2 dni wydać pierwszą wersję. Nowa konfiguracja trusted publishera wygasa, jeśli w tym czasie nie przejdzie przez nią udana publikacja.

1. **Konto npm z 2FA i lokalny npm 11.15.0 lub nowszy.** Sprawdź `npm --version`; Node 24 LTS ma npm 11.19.1. Tuż przed pierwszą publikacją sprawdź jeszcze, czy nazwa jest wolna: `npm view depcurfew` musi zwrócić `E404`.

2. **Utworzenie paczki bez publikowania kodu.** Trusted publishera można skonfigurować tylko dla istniejącej paczki. Etapowanie nowej paczki tworzy ją z publiczną wersją zastępczą `0.0.0-stage`; wersję próbną odrzucamy, więc żaden kod nie trafia do rejestru. W czystym klonie:

   ```bash
   npm login
   npm ci
   npm run build
   npm version 0.0.1-bootstrap.0 --no-git-tag-version
   npm stage publish --tag bootstrap
   npm stage list depcurfew
   npm stage reject <stage-id>
   git checkout -- package.json package-lock.json
   ```

   `npm stage reject` poprosi o 2FA.

3. **Trusted publisher z prawem tylko do etapowania** (decyzja z fazy 8: bez `--allow-publish`):

   ```bash
   npm trust github depcurfew --file release.yml --repo DevXord/depcurfew --allow-stage-publish
   ```

   To samo można zrobić na npmjs.com: paczka → **Settings** → **Trusted Publisher** → GitHub Actions; użytkownik `DevXord`, repozytorium `depcurfew`, plik workflow `release.yml`, bez środowiska, dozwolone tylko `npm stage publish`. npm nie sprawdza konfiguracji przy zapisie, więc literówka wyjdzie dopiero przy publikacji.

4. **Wyłączenie publikacji tokenami:** paczka → **Settings** → **Publishing access** → „Require two-factor authentication and disallow tokens” → **Update Package Settings**. Trusted publishing działa dalej, bo nie używa tokenów.

5. **Zalecane:** w ustawieniach repozytorium GitHub reguła, która pozwala tworzyć tagi `v*` tylko właścicielowi, żeby nikt inny nie mógł uruchomić workflow wydania.

## Każde wydanie

1. **Wersja.** Na gałęzi podnieś wersję (`npm version X.Y.Z --no-git-tag-version`), dopisz zmiany do `docs/CHANGELOG-dev.md`, scal PR do `main`. Wersja 1.0.0 jest już ustawiona w `package.json`.
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
7. **Po pierwszym wydaniu** w README: usunąć notę „pre-release” i wpisać w przykładzie Action pełny SHA commita wydania.

## Gdy coś nie działa

- **`ENEEDAUTH` przy etapowaniu:** nazwa pliku (`release.yml`), właściciel i repozytorium muszą zgadzać się dokładnie z konfiguracją trusted publishera, wielkość liter też. Workflow musi mieć `id-token: write` i działać na runnerze hostowanym przez GitHub.
- **Konfiguracja wygasła** (brak udanej publikacji w 2 dni): usuń ją, utwórz nową i od razu wydaj wersję.
- **Brak proweniencji:** publikacja musi przejść przez OIDC z publicznego repozytorium, a paczka musi być publiczna.
- **Zły tag albo wersja:** workflow zatrzyma się na sprawdzeniu tagu. Usuń tag (`git push origin :refs/tags/vX.Y.Z` i `git tag -d vX.Y.Z`), popraw i wypchnij ponownie. Błędną etapowaną wersję odrzuć: `npm stage reject <stage-id>`.
