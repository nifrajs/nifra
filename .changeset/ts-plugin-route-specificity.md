---
"@nifrajs/ts-plugin": patch
---

Go-to-definition on a route path now resolves to the most specific route, matching how the app routes at runtime: a static segment wins over a dynamic one, so `/users/new` jumps to `routes/users/new.tsx` rather than `routes/users/[id].tsx`, regardless of the order routes were discovered. The plugin also ships a CommonJS type entry, so editors that resolve its types through `require` see the correct factory shape.
