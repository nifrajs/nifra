---
"@nifrajs/web": patch
---

A loader or action value that holds an own `__proto__` key next to a `defer()` value keeps that key as ordinary data. Splitting the result for the shell rebuilt the containing object by assignment, which set its prototype instead of copying the key; the streamed resolve script for a deferred value read the JSON as a JavaScript object literal, which does the same in the browser. Both now keep the key as an own property, and the streamed value is parsed with `JSON.parse`, matching how the initial page data already arrives.
