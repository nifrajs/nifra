---
"@nifrajs/cli": major
---

`nifra check` follows the imports the bundler follows when it checks zones (NF-C028) and server-only imports (NF-C004): relative paths, tsconfig `paths` and `baseUrl` (through `extends`, from the nearest `tsconfig.json` or `jsconfig.json`), and package.json `imports`. A route that reaches backend code or a file in no zone through `~/lib/x` or `#db` is reported as it is through `../lib/x`. The app's `clientModule` counts as browser code wherever it lives: a `clientModule` in no zone or in backend code is an NF-C028 error at the config line, and what it imports is checked like a route's imports. A file in no zone is followed into what it imports, so every file the build would refuse is reported, each at its own import.
