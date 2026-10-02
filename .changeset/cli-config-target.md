---
"@nifrajs/cli": major
---

feat(cli)!: the deploy target lives in `nifra.config.ts`

- `export const target = "node"` in `nifra.config.ts` is what `nifra build` emits without
  `--target` (still `bun` when neither is given). `nifra port` and `nifra doctor` read it before any
  script heuristic.
- `nifra target` shows it; `nifra target <t>` switches it, rewriting only that line.
- The Cloudflare Pages target is `cloudflare` in `nifra build --target`, `nifra port --target` and the
  config; `cf-pages` is refused with the new name.
