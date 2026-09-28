/**
 * Making a route's declared `response` schema mean something at runtime.
 *
 * ## The gap this closes
 *
 * A `response` schema is a LOWER bound, not an upper one. It says "at least these fields, of these
 * types"; it never said "only these". TypeScript does not close the gap either - excess-property
 * checking fires on a fresh object literal in an annotated position, and a handler is neither: it is a
 * contextually-typed argument that usually returns a variable. So this compiles, and ships every field:
 *
 *     app.get("/me", { response: PublicUser }, async () => {
 *       const user = await db.users.find(id)   // { id, name, email, passwordHash, ... }
 *       return user                            // all of it goes on the wire
 *     })
 *
 * The client's type says `{ id, name }`, so the leak is invisible from both ends. And it can appear
 * with no code change at all: add a column to `users`, and the next deploy ships it to browsers.
 *
 * ## Why the behaviour follows the schema, not this module
 *
 * Standard Schema exposes exactly one operation - `validate` - and no way to enumerate a schema's
 * declared keys. So a projection of "just the declared fields" cannot be written generically here;
 * the only clean value available is whatever `validate()` returns. That is deliberate on the spec's
 * part, and it means enforcement inherits each validator's own semantics:
 *
 *   - a STRIPPING schema (zod, valibot) returns a cleaned value -> the undeclared fields are removed
 *   - a STRICT schema (`@nifrajs/schema`'s `t.object`) reports issues -> the response is a violation
 *
 * That is not an inconsistency to paper over: a strict schema has already declared that extra fields
 * are an error, and a stripping one has declared they are ignorable. Enforcement honours what the
 * author wrote rather than overriding it.
 *
 * ## What enforcement costs
 *
 * Less than it looks like it should. With a compiled validator (`@nifrajs/schema`'s `t` compiles at
 * construction; zod/valibot equivalents are similarly cheap), the check itself measures in the
 * ~100ns-per-response range - on a realistic middleware-carrying route, enforce mode benchmarks
 * within measurement noise of the same route with no contract at all, on Bun and Node alike. The
 * one real cost is structural: a contracted route cannot take the bare-route fused lane, because
 * the check needs the handler's VALUE before it becomes bytes. A route with any middleware, derive,
 * or lifecycle hook has already left that lane, so for the routes that look like production the
 * contract is effectively free - declare it.
 */
import {
  formatStandardIssues,
  type StandardResult,
  type StandardSchemaV1,
} from "../schema/standard.ts"
import { INSTALL_RESPONSE_CONTRACT } from "./install.ts"
import type { IdentityPlugin } from "./plugin.ts"
import { isResponseResult, status } from "./runtime-core.ts"
import type { AnyServer } from "./server.ts"

/**
 * How hard a declared `response` schema is held.
 *
 *   - `warn`    - check and log; the response is sent UNCHANGED, so enabling it cannot break anything.
 *   - `enforce` - serialize the validated value, so undeclared data cannot reach the wire.
 *
 * There is no `off`: not installing the plugin IS off, and that is what keeps this module out of an
 * app's bundle entirely rather than shipping a disabled branch to everyone.
 */
export type ResponseContractMode = "warn" | "enforce"

/** Success and status-specific error schemas captured by one route at registration time. */
export interface ResponseContractDefinition {
  readonly response?: StandardSchemaV1
  readonly errors?: Readonly<Record<number, StandardSchemaV1>>
}

/** The outcome of checking one handler result against its declared response schema. */
export type ResponseContractOutcome =
  /** Nothing to report. `value` is what should be serialized (the original result, or the cleaned one). */
  | { readonly kind: "ok"; readonly value: unknown }
  /** `warn` only: the payload differed from the contract. The ORIGINAL result is still served. */
  | { readonly kind: "warn"; readonly value: unknown; readonly message: string }
  /** `enforce` only: the payload cannot be reconciled with the contract, so it must not be sent. */
  | { readonly kind: "violation"; readonly message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Top-level keys present in the handler's result but absent from the validated value. */
function droppedKeys(result: unknown, value: unknown): string[] {
  if (!isPlainObject(result) || !isPlainObject(value)) return []
  return Object.keys(result).filter((k) => !(k in value))
}

/**
 * Check one result against the route's declared response schema.
 *
 * Returns synchronously when the schema does (the common case), so an app that opts in does not pay a
 * microtask per response for a check that had no work to do.
 */
export function checkResponseContract(
  schema: StandardSchemaV1,
  result: unknown,
  mode: "warn" | "enforce",
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  return checkRouteResponseContract({ response: schema }, result, mode)
}

/**
 * Check a route's success or status-specific error payload. Plain `status()` results retain their
 * status while enforcement replaces only the body with the validator's output. Raw `Response`
 * remains an explicit transport escape hatch because inspecting it would consume streams or alter
 * redirects; assurance/static checks must govern that path separately.
 */
export function checkRouteResponseContract(
  definition: ResponseContractDefinition,
  result: unknown,
  mode: "warn" | "enforce",
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  const plain = isResponseResult(result) ? result.plain : undefined
  if (plain !== undefined) {
    const schema =
      plain.status >= 200 && plain.status < 300
        ? definition.response
        : definition.errors?.[plain.status]
    if (schema === undefined) return { kind: "ok", value: result }
    return validateContract(schema, plain.body, mode, (value) =>
      status(
        plain.status,
        value,
        plain.headers === undefined ? undefined : { headers: plain.headers },
      ),
    )
  }

  // A handler may return a raw Response as deliberate control flow (a redirect, a stream). There is no
  // JSON payload to hold to the contract, and re-serializing one would corrupt it. A `status(...)` is
  // intentionally handled above because its plain body and status remain available without consuming
  // a stream. An absent body has nothing to validate.
  if (result instanceof Response || result === undefined) return { kind: "ok", value: result }
  const schema = definition.response
  if (schema === undefined) return { kind: "ok", value: result }
  return validateContract(schema, result, mode, (value) => value)
}

function validateContract(
  schema: StandardSchemaV1,
  result: unknown,
  mode: "warn" | "enforce",
  replace: (value: unknown) => unknown,
): ResponseContractOutcome | Promise<ResponseContractOutcome> {
  const settled = schema["~standard"].validate(result)
  return settled instanceof Promise
    ? settled.then((r) => interpret(r, result, mode, replace))
    : interpret(settled, result, mode, replace)
}

function interpret(
  settled: StandardResult<unknown>,
  result: unknown,
  mode: "warn" | "enforce",
  replace: (value: unknown) => unknown,
): ResponseContractOutcome {
  if (settled.issues !== undefined) {
    const message = `response does not satisfy its declared contract: ${formatStandardIssues(settled.issues)}`
    // `warn` never changes what is served - it reports and gets out of the way, so switching it on can
    // never be the thing that broke production.
    return mode === "warn"
      ? { kind: "warn", value: result, message }
      : { kind: "violation", message }
  }
  const dropped = droppedKeys(result, settled.value)
  if (mode === "enforce") return { kind: "ok", value: replace(settled.value) }
  return dropped.length === 0
    ? { kind: "ok", value: result }
    : {
        kind: "warn",
        value: result,
        message: `response carries fields its contract does not declare: ${dropped.join(", ")}. They are being sent; \`responseContract: "enforce"\` would strip them.`,
      }
}

/**
 * What the server holds when the plugin is installed. The kernel calls `check` through this object and
 * never imports the implementation, so an app that does not install the plugin does not carry it.
 */
export interface ResponseContractRuntime {
  readonly mode: ResponseContractMode
  check(
    definition: ResponseContractDefinition,
    result: unknown,
  ): ResponseContractOutcome | Promise<ResponseContractOutcome>
}

interface ResponseContractInstallable {
  [INSTALL_RESPONSE_CONTRACT](runtime: ResponseContractRuntime): void
}

/**
 * Hold every route's declared `response` schema to what the handler actually returned.
 *
 *     app.use(responseContract("enforce"))
 *
 * Install it before the routes it should cover - like `idempotency()`, the decision is made per route
 * at registration, so routes registered earlier are not retroactively covered.
 *
 * The check itself is cheap - with a compiled validator it measures in the ~100ns-per-response
 * range, within benchmark noise of an uncontracted route on any route that carries middleware or a
 * derive. What a contracted route does give up is the bare-route fused lane (the check needs the
 * handler's value before it becomes bytes), which only a route with NO other lifecycle steps was
 * taking anyway. Opt-in because not installing the plugin keeps the lane out of the bundle, not
 * because enforcement is expensive.
 */
export function responseContract(mode: ResponseContractMode = "warn"): IdentityPlugin {
  const runtime: ResponseContractRuntime = {
    mode,
    check: (definition, result) => checkRouteResponseContract(definition, result, mode),
  }
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as ResponseContractInstallable)[INSTALL_RESPONSE_CONTRACT](runtime)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:response-contract" }) as IdentityPlugin
}
