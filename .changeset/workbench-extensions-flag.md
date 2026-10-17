---
"@nifrajs/workbench": patch
---

Workbench loads a project's `.nifra/extensions/**` only when it is started with `--extensions`, matching `nifra-agent`. Without the flag a Pi-backed session runs no project extension code; pass it only for a repository you trust, since an extension's top-level code runs as soon as it is imported.
