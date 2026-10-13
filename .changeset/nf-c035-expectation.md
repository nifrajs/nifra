---
"@nifrajs/cli": patch
---

`nifra check`'s NF-C035 accepts `// nifra-expect NF-C035: <reason>` on a `createWebApp` call, or on its `apiPrefix` line, for an app whose backend another server already serves where `nifra dev` does. The finding at the call says so, and for a call that passes no `apiPrefix` it adds that one there would give the backend a second path that skips that server's middleware.
