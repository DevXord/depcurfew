## What changes

<!-- What the change does for users, and the decision in docs/decisions.md it adds or changes. -->

## Checks

- [ ] `npm test`, `npm run typecheck` and `npm run check:pkg` pass
- [ ] Generated files are up to date (`npm run docs:knowledge`, `npm run docs:readme`, `npm run schema`, `npm run build:action`)
- [ ] New facts about package managers live in `src/knowledge/` with `source` and `verifiedAt`
- [ ] No new dependency, or it was agreed in an issue first and is justified in `docs/decisions.md`
- [ ] User-facing changes are in `CHANGELOG.md`
