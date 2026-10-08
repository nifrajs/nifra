---
"@nifrajs/cli": minor
---

`nifra check` and `nifra capabilities` read a WebSocket route's path given as a module-level string `const`, in the same file or imported from a project file, as they do for HTTP routes. A socket path built at runtime gets the same NF-C036 finding, listed as `WS`.
