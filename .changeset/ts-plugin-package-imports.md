---
"@nifrajs/ts-plugin": patch
---

The editor plugin's zone check now resolves a package.json import such as `#server/db`. It used to cut the specifier at its first `?` or `#`, counting the leading `#`, so TypeScript got an empty specifier and the import was never checked. A query after the name (`#server/db?raw`) is still dropped.
