---
"@nifrajs/cli": patch
---

`nifra doctor` reports a renamed session cookie only where `name` is given a string, so a type such as `sessionToken: { name: string }` in a wrapper package no longer asks for `identityCookies`.
