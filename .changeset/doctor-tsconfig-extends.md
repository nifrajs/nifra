---
"@nifrajs/cli": patch
---

`nifra doctor` (and the undeclared-dependency rule in `nifra check`) now read `tsconfig.json` the way TypeScript does. It used strict `JSON.parse` and ignored `extends`. A tsconfig with a comment or a trailing comma, or one that takes its `paths` from a shared base, made every alias import look like an undeclared package and failed the check. Doctor now uses the nearest tsconfig at or above each package, follows its `extends` chain, and accepts comments and trailing commas.
