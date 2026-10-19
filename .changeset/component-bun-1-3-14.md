---
"@nifrajs/web": patch
---

React server components on Bun need Bun 1.3.14 or later. Bun 1.3.0 through 1.3.13 cannot parse the React 19.3.1 server renderer (a labeled `if` used as an `else` branch), so the runtime matrix now certifies Bun 1.3.14 and 1.4.3 instead of 1.3.0.
