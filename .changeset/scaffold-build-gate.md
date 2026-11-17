---
"create-nifra": minor
---

A new site scaffold's `build` script now runs `nifra check` and `nifra assure` before `nifra build`, so the contract and assurance gates are part of the default build instead of a command the developer has to remember. The ISR template runs the same two gates before its build script. The separate `check` script is unchanged.
