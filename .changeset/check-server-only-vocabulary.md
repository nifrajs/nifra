---
"@nifrajs/cli": patch
"@nifrajs/web": minor
---

`nifra check`'s server-only import rule (NF-C004) names server code the way the browser build does. It knew eight drivers; it now takes the build's list of server packages and driver entries (`stripe`, `@prisma/client`, `jsonwebtoken`, `bcrypt`, `nodemailer` and the rest), bare Node builtins with no browser counterpart (`fs`, `child_process`, `crypto`, ...), `require("x")` and `import x = require("x")`, and an installed workspace package that declares `"nifra": { "environment": "backend" }`. Bare `events`, `buffer`, `path` and `util` still pass, since each also names a browser polyfill. `@nifrajs/web/zones` exports the check as `isServerPackageSpecifier`.
