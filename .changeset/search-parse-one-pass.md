---
"@nifrajs/web": patch
---

A route's query string is read in one pass, and a value is handed to `JSON.parse` only when it can be JSON, so plain words no longer go through a throwing parse. The parsed values, their order, the key limit, the depth cap and the dropped keys are unchanged.
