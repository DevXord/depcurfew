# Dziennik zmian (deweloperski)

Krótkie podsumowanie po każdej fazie planu. Decyzje i ich uzasadnienia są w `docs/decisions.md`.

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
