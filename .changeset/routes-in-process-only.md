---
"@nifrajs/cli": patch
---

With `apiPrefix` set and `apiStrip` off, the backend sees each request's full path, so a route registered outside the prefix is reachable only in-process through `ctx.api`. `nifra routes` marks such a route `in-process only` (`inProcessOnly` with `--json`), and `nifra dev` and `nifra build` warn about them.
