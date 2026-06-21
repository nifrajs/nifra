# @nifrajs/env

Typed, validated environment variables. Define a schema once at startup; get a **frozen, typed**
object — or a **loud boot-time failure listing every problem at once**, so a misconfigured deploy
fails immediately instead of erroring on the first request that touches a bad var. The config half
of nifra's "validate at every boundary" rule. Dependency-free, edge-safe.

```ts
// env.ts — imported once at startup
import { defineEnv, env } from "@nifrajs/env"

export const ENV = defineEnv({
  DATABASE_URL: env.url(),
  PORT: env.port({ default: 3000 }),
  NODE_ENV: env.enum(["development", "production", "test"], { default: "development" }),
  STRIPE_SECRET: env.string(),
  DEBUG: env.boolean({ default: false }),
  SENTRY_DSN: env.url({ optional: true }),
})

// ENV.PORT      → number
// ENV.NODE_ENV  → "development" | "production" | "test"
// ENV.DEBUG     → boolean
// ENV.SENTRY_DSN → string | undefined
```

A missing/invalid var fails at import:

```
[nifra/env] invalid environment — 2 problem(s):
  DATABASE_URL: must be a valid URL
  STRIPE_SECRET: is required

Set the variable(s) above and restart.
```

## Coercing helpers

Every value in `process.env` is a `string | undefined`; these turn it into the value you want:

| helper | type | notes |
| --- | --- | --- |
| `env.string({ default?, optional? })` | `string` | empty string counts as unset |
| `env.number({ default?, optional? })` | `number` | finite, coerced |
| `env.port({ default? })` | `number` | integer 1–65535 |
| `env.boolean({ default? })` | `boolean` | `true`/`1`/`yes`/`on` vs `false`/`0`/`no`/`off`/empty |
| `env.enum([...], { default? })` | union | one of the listed values |
| `env.url({ default?, optional? })` | `string` | parses with WHATWG `URL`, returns the normalized href |

`optional: true` makes the type `T | undefined`; `default` supplies a fallback when unset.

## Bring your own validator

`defineEnv` accepts **any Standard Schema** (`t` from `@nifrajs/schema`, zod, valibot), not just the
`env.*` helpers — handy for a shape the helpers don't cover. Only the `env.*` helpers coerce from
strings, though: a plain `t.number()` would see the raw string, so reach for `env.number()` when you
need coercion.

## Edge runtimes

`defineEnv` reads `process.env` by default (Bun/Node). Cloudflare Workers has no `process.env` —
pass the request's bindings: `defineEnv(shape, { source: env })`.

## Secret safety

Error messages name the offending variable and the reason — **never its value** (it may be a
secret). `defineEnv` returns a frozen object, so a validated config can't be mutated downstream.

## For AI agents

Building on nifra with an AI coding agent? The repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste
quick reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.
