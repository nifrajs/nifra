/**
 * @nifrajs/env — typed, validated environment variables. Define a schema once at startup; get a
 * frozen typed object, or a loud boot-time failure listing every problem. Coercing helpers
 * (`env.number`/`port`/`boolean`/`url`/`enum`) turn `string | undefined` into the value you want;
 * any Standard Schema (`t`, zod, valibot) is also accepted. Dependency-free, edge-safe.
 */

export { type DefineEnvOptions, defineEnv, type EnvResult, type EnvShape } from "./define.ts"
export { boolean, enumValue, env, number, port, string, url } from "./helpers.ts"
export type { InferOutput, StandardResult, StandardSchemaV1 } from "./schema.ts"
