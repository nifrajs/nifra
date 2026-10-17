---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

One module inside `frontend/` or `backend/` can be declared shared where it is: name it `*.shared.ts` (any script extension), or list its path under `"nifra": { "zones": { "shared": [...] } }`. It is then held to the shared zone's rules, so it may import only shared code and packages, and `nifra check` reports each import that breaks them. A `shared` entry inside one of those folders was refused before; entries for other zones still are, and the refusal now says which entry may name such a path. A file listed under another zone keeps that zone whatever its name.

NF-C028 now says which remedy applies when server code imports a frontend module: when the module imports only shared code and packages, it names the rename and the config entry that share it in place; otherwise it names the first import that keeps it from being shared, and says to move what both sides need into `shared/`.
