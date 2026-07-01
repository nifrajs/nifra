---
"create-nifra": minor
---

feat(create-nifra): `--template fullstack` — a batteries-included starter

`bun create nifra my-app --template fullstack` scaffolds an app that already wires the packages a real
backend needs on top of core: cursor pagination (`t.pageQuery` / `t.paginated` / `paginate`), background
jobs (`@nifrajs/jobs`), a single-flight TTL cache (`@nifrajs/cache`), and blob storage (`@nifrajs/storage`)
— over a `notes` domain you swap for your DB. Ships with tests exercising each. Complements the existing
`api`, `site`, and `isr` templates.
