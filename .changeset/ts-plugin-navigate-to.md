---
"@nifrajs/ts-plugin": patch
---

Workspace symbol search (navigate to) is no longer slowed by the plugin: a search string is passed to TypeScript as-is instead of being looked up as a file name across the whole program.
