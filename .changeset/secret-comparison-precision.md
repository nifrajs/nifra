---
"@nifrajs/cli": patch
---

`nifra check` no longer reports these as non-constant-time secret comparisons (NF-S002): a comparison against `true` or `false`; a name whose last word states a fact about the secret rather than holding it (`type`, `kind`, `name`, `id`, `ids`, `length`, `len`, `count`, `size`, `mode`, `policy`, `version`, `sqlstate`, `status`, `enabled`, `required`, `ttl`, `expiry`, `expires`), such as `tokenType` or `SECRET_CAP_SQLSTATE`; and a comparison of two configuration reads (`process.env.X`, `Bun.env.X`, `import.meta.env.X`, `Deno.env.get("X")`, and `env.X` or `c.env.UPPER_SNAKE` where `env` or `c` is a parameter of the enclosing function). The secret word anywhere else in a name still matches, so `tokenValue`, `passwordHash`, `secretCode` and `tokenPrefix` are still reported, as is a configuration read compared with anything else.
