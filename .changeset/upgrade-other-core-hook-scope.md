---
"@nifrajs/cli": patch
---

`nifra upgrade --write` run from a CLI whose `@nifrajs/core` is not the project's, such as `bunx @nifrajs/cli@<new> upgrade <new>` before the new release is installed, no longer prints `Hook scope: not captured (merge() requires a server() from this copy of @nifrajs/core, ...)` with a list of copies. That state is expected mid-upgrade, so it skips the hook report and prints one line saying `nifra routes --hooks` shows the hook scope once the release is installed. The JSON report carries `hooks: { "skipped": "other-core" }`.
