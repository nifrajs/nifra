---
"@nifrajs/cli": patch
---

`nifra migrate layout` re-points a moved module's paths from its own location so each still reaches
what it did: `join(import.meta.dir, "..", "x")`, `import.meta.dir + "/../x"`, `` `${__dirname}/../x` ``
and `new URL("../x", import.meta.url)` with literal segments; any other use of its location is
reported. It also reports a folder that some files leave while others stay (a runner that lists
`migrations/` misses what moved), and scripts or config beside the code (`package.json`, shell scripts,
YAML, TOML) that name a moved file by path. An import that still reads like an old path but resolves
after the moves is no longer reported.
