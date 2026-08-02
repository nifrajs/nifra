---
"@nifrajs/ts-plugin": minor
---

New package: a TypeScript language-service plugin. Go-to-definition on a route-path string literal jumps to the `routes/` file that serves it.

Put your cursor on `"/orders"` in `navigate({ to: "/orders" })`, `<Link to="/orders">`, or `href="/orders"`, and jump straight to the file. The routing is nifra's own - routes discovered with `@nifrajs/web`, matched with `@nifrajs/core`'s pattern matcher - so a path resolves to exactly the file it would serve at runtime, dynamic segments included (`/users/42` → `routes/users/[id].tsx`). Enable it with `{ "compilerOptions": { "plugins": [{ "name": "@nifrajs/ts-plugin" }] } }`.
