---
"@nifrajs/cli": patch
---

`nifra check`'s server-only import walk (NF-C004) no longer stops at 8 hops or 200 modules. A sink past either limit, such as one module in a barrel of 250, was dropped without a word and the check passed. The walk now reads, parses and resolves each module once per check and searches each module's chain once, however many routes share it: 400 routes over 250 shared modules went from about 101,000 module reads and 1.3 s to 251 reads and 49 ms. `createServerOnlyChains` is the per-check entry point; `resolveServerOnlyChains` still answers for one module.
