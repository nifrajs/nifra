---
"@nifrajs/cli": patch
"create-nifra": patch
---

NF-C007 no longer reports a route the typed client still types. A handler that returns a plain value beside a raw `Response` (`if (!note) return c.json({ error }, 404); return note`) keeps `data` typed, because the client drops a bare `Response` from the union, and a route that declares `{ response: t.… }` is typed by its schema, as the advisory's own hint says. A handler whose returns are all a `Response`, or calls `nifra check` cannot see into, is still reported. The batteries starter checks clean again, and the ISR starter marks its built-file route.
