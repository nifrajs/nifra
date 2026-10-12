---
"@nifrajs/cli": patch
---

`nifra check` decides which imports load a module the way the compiler emits them. An import whose named specifiers are all `type` (`import { type X } from "./x"`) is no zone edge (NF-C028), as it already was no server-only edge (NF-C004), unless the file's tsconfig sets `verbatimModuleSyntax`, under which it is emitted as `import {} from "./x"` and both rules check it. An import with a default binding (`import x, { type Y } from "./x"`) and an explicit `import {} from "./x"` or `export {} from "./x"` load their module and are checked by both rules.
