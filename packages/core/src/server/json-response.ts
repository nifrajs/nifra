import { retried } from "./json-text.ts"

/** `Response.json`, with each `bigint` written as its decimal string, as `jsonText` writes it. */
export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  try {
    return Response.json(value, init)
  } catch (error) {
    const text = retried(value, error)
    // Parsed back so the runtime's own `Response.json` still picks the content-type, and still
    // throws for a value with no JSON form.
    return Response.json(typeof text === "string" ? JSON.parse(text) : value, init)
  }
}
