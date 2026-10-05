---
"@nifrajs/web": patch
---

The browser zone guard no longer refuses an extensionless import of a dotted source file. `import { x } from "../lib/calendar.shared"` (or `./date.utils`) was read as an asset with the extension `.shared`, judged by its bare path, refused, and then reported as "missing from the graph" once Bun loaded the real `.ts` file, so a `*.shared.ts` module outside the zone folders failed the client build and the dev server. Zone suffixes are no longer treated as asset extensions, and a path that names no file on disk is left to the source-file check, which judges the file Bun actually resolves.
