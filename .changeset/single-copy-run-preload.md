---
"@nifrajs/core": patch
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

`nifra check` and `nifra doctor` no longer call a single-copy declaration enforced when `bunfig.toml`
preloads the registrar for only one of `bun run` and `bun test`. Each finding lists the commands that
still load both copies, and the report names a `preload` line written below a table such as
`[install]`, where Bun reads it as that table's key. When `@nifrajs/core` loads twice in a process
where no single-copy registrar ran, its warning says so.
