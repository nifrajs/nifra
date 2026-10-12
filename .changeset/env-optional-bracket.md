---
"@nifrajs/web": patch
---

The private-environment check that `nifra check`, `nifra dev` and both builds share reads optional bracket access the way it reads dot access: `process.env?.["PUBLIC_X"]` is the public read it is, and `process.env?.["SECRET"]` is refused by name instead of as a whole-object read. Bracket access on the owner (`process["env"]`, `process?.["env"]`) and an optional call (`Deno.env.get?.("X")`) read the same way. A computed name (`process.env?.[name]`) is still refused.
