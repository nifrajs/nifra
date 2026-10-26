---
"@nifrajs/cli": patch
---

`nifra doctor` no longer warns that nothing names an app's sign-in cookie when the app reaches `@nifrajs/auth`, Better Auth or Auth.js through a package of its own, such as a workspace or linked wrapper. It follows the app's installed and linked dependencies - a library a wrapper declares but the install lacks, such as an unmet peer or optional dependency, does not count - and prints a note instead, naming the dependency chain and the rule that covers the cookie: its default name, or Better Auth's `<prefix>.session_token` suffix. The JSON result carries it as `keepAliveIdentityCovered`. A session cookie renamed outright, in the app's own source or in a workspace or linked package on that chain, still warns, and so does an app that reaches no supported auth library and sets no `identityCookies`.
