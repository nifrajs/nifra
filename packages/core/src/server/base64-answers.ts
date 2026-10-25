/**
 * Bytes in a JSON answer, written as base64.
 *
 * `JSON.stringify` writes a `Uint8Array` as `{"0":1,"1":2,...}`, and nothing about that throws, so
 * finding one costs a walk of every answer. Only a route that asks pays for that walk: `t.bytes()` in
 * its `response` or `errors` has core hand {@link withBase64Bytes} the route's handler and the hooks
 * that can answer in its place, and every `Uint8Array` in what any of them returns or throws as an
 * answer becomes a base64 string before a later hook, contract or writer sees it. Nothing in the
 * server imports this module, so an app that never declares the field never bundles it.
 */
import { tagStandIn } from "../internal/hook-origins.ts"
import type { AnswerStages, JsonReplyContext } from "./answer-step.ts"
import { isResponseResult, status } from "./runtime-core.ts"

// Deeper than any real payload.
const MAX_DEPTH = 64
// So `String.fromCharCode(...)` never overflows the call stack.
const CHUNK = 0x8000

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function define(out: object, key: string, value: unknown): void {
  // `out[key] = value` for "__proto__" would replace the prototype instead of adding the field.
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * `value` with each `Uint8Array` as base64, copying only the containers above one. A container already
 * on the walk's path is left as it is, so a cycle costs one step, as it does `JSON.stringify`, which
 * then refuses it.
 */
function encoded(value: unknown, depth: number, path: Set<object>): unknown {
  if (value instanceof Uint8Array) return base64(value)
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH || path.has(value))
    return value
  // A `Date` (or any value with a hook) writes itself.
  if (typeof Reflect.get(value, "toJSON") === "function") return value
  path.add(value)
  try {
    if (Array.isArray(value)) {
      let out: unknown[] | undefined
      for (let i = 0; i < value.length; i++) {
        const next = encoded(value[i], depth + 1, path)
        if (next === value[i]) continue
        out ??= [...value]
        out[i] = next
      }
      return out ?? value
    }
    let out: object | undefined
    for (const key of Object.keys(value)) {
      const item: unknown = Reflect.get(value, key)
      const next = encoded(item, depth + 1, path)
      if (next === item) continue
      out ??= { ...value }
      define(out, key, next)
    }
    return out ?? value
  } finally {
    path.delete(value)
  }
}

const encodedBody = (body: unknown): unknown => encoded(body, 0, new Set())

/** An answer with its bytes encoded. A raw `Response` is left alone; a `c.json(...)` reply is rebuilt
 * from the value it was made from, keeping its status and headers. */
function encodedAnswer(answer: unknown, c: JsonReplyContext): unknown {
  if (answer instanceof Response) {
    if (answer !== c.jsonReply) return answer
    const body = encodedBody(c.jsonBody)
    if (body === c.jsonBody) return answer
    const headers = new Headers(answer.headers)
    headers.delete("content-length")
    return c.json(body, { status: answer.status, headers })
  }
  if (isResponseResult(answer)) {
    const plain = answer.plain
    if (plain === undefined) return answer
    const body = encodedBody(plain.body)
    if (body === plain.body) return answer
    return status(
      plain.status,
      body,
      plain.headers === undefined ? undefined : { headers: plain.headers },
    )
  }
  return encodedBody(answer)
}

/** A thrown answer (`status(...)`, `c.json(...)`) is encoded too; any other throw passes untouched. */
const encodedThrow = (thrown: unknown, c: JsonReplyContext): unknown =>
  thrown instanceof Response || isResponseResult(thrown) ? encodedAnswer(thrown, c) : thrown

/**
 * `stage` with what it returns or throws as an answer encoded. Its context is argument `at`; an
 * `undefined` return (a hook that lets the route go on) stays `undefined`.
 */
function encoding<F extends (...args: never[]) => unknown>(stage: F, at: 0 | 1): F {
  const wrapped = (...args: never[]): unknown => {
    const c: JsonReplyContext = args[at]!
    let result: unknown
    try {
      result = stage(...args)
    } catch (thrown) {
      throw encodedThrow(thrown, c)
    }
    if (!(result instanceof Promise)) return encodedAnswer(result, c)
    return result.then(
      (answer) => encodedAnswer(answer, c),
      (thrown) => {
        throw encodedThrow(thrown, c)
      },
    )
  }
  // Named as the stage, so stack traces and the hook report still name the author's function.
  Object.defineProperty(wrapped, "name", { value: stage.name })
  tagStandIn(wrapped, stage)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the wrapper takes `F`'s arguments and returns `unknown`, which is every stage's own return type.
  return wrapped as F
}

/** A route's handler and answering hooks, each wrapped so every `Uint8Array` it answers leaves as
 * base64. */
export function withBase64Bytes<S extends AnswerStages>(stages: S): S {
  return {
    ...stages,
    handler: encoding(stages.handler, 0),
    beforeHandle: stages.beforeHandle.map((hook) => encoding(hook, 0)),
    afterHandle: stages.afterHandle.map((hook) => encoding(hook, 1)),
    onError: stages.onError.map((hook) => encoding(hook, 1)),
  }
}
