---
"@nifrajs/cli": minor
---

The interpolated-SQL check (NF-C006) reads a function-local `const` as static text when its initializer is, so `const dir = desc ? "DESC" : "ASC"` or `const cols = "id, email"` inside a handler no longer flags. It also reads `.join(sep?)` with a literal or absent separator over an array that still holds its literal elements: an inline array, `Object.freeze([...])`, or a `const` array in the same file that is not exported and is only ever read with `.join()`, `.includes()`, `.indexOf()` or `.length`. An imported array counts only when frozen; `as const` does not count. A `let`, a parameter, an array that is pushed to, passed to a call or exported unfrozen, a shadowed name, and a template with a call inside still flag.
