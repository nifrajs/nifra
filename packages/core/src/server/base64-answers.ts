/**
 * Bytes in a JSON answer, written as base64.
 *
 * `JSON.stringify` writes a `Uint8Array` as `{"0":1,"1":2,...}`, and nothing about that throws, so
 * finding one costs a walk of every answer. Only a route that asks pays for that walk: `t.bytes()` in
 * its `response` or `errors` has core wrap its handler with {@link withBase64Bytes} at registration,
 * and every `Uint8Array` in what it returns or throws as an answer becomes a base64 string before any
 * hook, contract or writer sees it. Nothing in the server imports this module, so an app that never
 * declares the field never bundles it.
 */
import type { JsonReplyContext } from "./answer-step.ts"
import { isResponseResult, status } from "./runtime-core.ts"

// Deeper than any real payload; it also ends a walk into a cycle, which JSON cannot carry.
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

/** `value` with each `Uint8Array` as base64, copying only the containers above one. */
function encoded(value: unknown, depth: number): unknown {
  if (value instanceof Uint8Array) return base64(value)
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return value
  // A `Date` (or any value with a hook) writes itself.
  if (typeof Reflect.get(value, "toJSON") === "function") return value
  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const next = encoded(value[i], depth + 1)
      if (next === value[i]) continue
      out ??= [...value]
      out[i] = next
    }
    return out ?? value
  }
  let out: object | undefined
  for (const key of Object.keys(value)) {
    const item: unknown = Reflect.get(value, key)
    const next = encoded(item, depth + 1)
    if (next === item) continue
    out ??= { ...value }
    define(out, key, next)
  }
  return out ?? value
}

/** A handler's answer with its bytes encoded. A raw `Response` is left alone; a `c.json(...)` reply is
 * rebuilt from the value it was made from, keeping its status and headers. */
function encodedAnswer(answer: unknown, c: JsonReplyContext): unknown {
  if (answer instanceof Response) {
    if (answer !== c.jsonReply) return answer
    const body = encoded(c.jsonBody, 0)
    if (body === c.jsonBody) return answer
    const headers = new Headers(answer.headers)
    headers.delete("content-length")
    return c.json(body, { status: answer.status, headers })
  }
  if (isResponseResult(answer)) {
    const plain = answer.plain
    if (plain === undefined) return answer
    const body = encoded(plain.body, 0)
    if (body === plain.body) return answer
    return status(
      plain.status,
      body,
      plain.headers === undefined ? undefined : { headers: plain.headers },
    )
  }
  return encoded(answer, 0)
}

/** A thrown answer (`status(...)`, `c.json(...)`) is encoded too; any other throw passes untouched. */
const encodedThrow = (thrown: unknown, c: JsonReplyContext): unknown =>
  thrown instanceof Response || isResponseResult(thrown) ? encodedAnswer(thrown, c) : thrown

/** Wrap a route handler so every `Uint8Array` in its answer leaves as base64. */
export function withBase64Bytes<C extends JsonReplyContext>(
  handler: (context: C) => unknown,
): (context: C) => unknown {
  return (c) => {
    let result: unknown
    try {
      result = handler(c)
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
}
