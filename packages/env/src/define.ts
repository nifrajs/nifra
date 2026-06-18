import type { InferOutput, StandardSchemaV1 } from "./schema.ts"

/** A schema per variable name. */
export type EnvShape = Record<string, StandardSchemaV1>

/** The frozen, validated result — each key typed by its schema's output. */
export type EnvResult<S extends EnvShape> = { readonly [K in keyof S]: InferOutput<S[K]> }

export interface DefineEnvOptions {
  /**
   * Where to read variables from. Defaults to `process.env` (Bun/Node). On Cloudflare Workers there
   * is no `process.env` — pass the request's `env` bindings: `defineEnv(shape, { source: env })`.
   */
  readonly source?: Record<string, string | undefined>
}

/**
 * Validate the environment against a schema and return a **frozen, typed** object — or throw at
 * startup listing **every** problem at once (not just the first), so a misconfigured deploy fails
 * loud and immediately instead of erroring on the first request that touches a bad var. This is the
 * boot-time half of nifra's "validate at every boundary" rule, for config.
 *
 * ```ts
 * // env.ts — imported once at startup
 * import { defineEnv, env } from "@nifrajs/env"
 * export const ENV = defineEnv({
 *   DATABASE_URL: env.url(),
 *   PORT: env.port({ default: 3000 }),
 *   NODE_ENV: env.enum(["development", "production", "test"], { default: "development" }),
 *   STRIPE_SECRET: env.string(),
 *   DEBUG: env.boolean({ default: false }),
 * })
 * // ENV.PORT: number, ENV.NODE_ENV: "development" | "production" | "test", … all validated.
 * ```
 *
 * Errors name the offending variable and the reason — never its value (it may be a secret). BYO
 * validators (`t`, zod, valibot) work too; only the `env.*` helpers coerce from strings, so a plain
 * `t.number()` would see the raw string — use `env.number()` for coercion.
 */
export function defineEnv<S extends EnvShape>(shape: S, options?: DefineEnvOptions): EnvResult<S> {
  const source =
    options?.source ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {}
  const out: Record<string, unknown> = {}
  const problems: string[] = []

  for (const key of Object.keys(shape)) {
    const schema = shape[key] as StandardSchemaV1
    const result = schema["~standard"].validate(source[key])
    if (result instanceof Promise) {
      // Env validation must be synchronous (it runs once, at import) — an async validator is a
      // configuration mistake, surfaced as a problem rather than an unhandled promise.
      problems.push(`  ${key}: async validators are not supported in defineEnv`)
      continue
    }
    if (result.issues !== undefined) {
      for (const i of result.issues) problems.push(`  ${key}: ${i.message}`)
    } else {
      out[key] = result.value
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[nifra/env] invalid environment — ${problems.length} problem(s):\n${problems.join("\n")}\n\nSet the variable(s) above and restart.`,
    )
  }
  return Object.freeze(out) as EnvResult<S>
}
