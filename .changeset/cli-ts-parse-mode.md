---
"@nifrajs/cli": patch
---

`nifra check` parses a `.ts`, `.mts`, or `.cts` file as TypeScript instead of TSX in its SQL interpolation scan, security rules, nano and island lints, and route source facts. A generic arrow (`<T>(items: T[]) => ...`) or an angle-bracket cast in such a file no longer makes the file unparsable or hides the code after it from those checks, so findings they missed there now appear.
