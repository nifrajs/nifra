/**
 * The ceiling row - a hand-written payload-v2 handler with no framework, no Web Request/Response
 * round trip, and no router: a path check and a JSON.parse.
 *
 * Its `initMs` is this box's floor for "Node booted a bundle and reached the first statement", so
 * every framework row should be read as its distance from this row, not as an absolute. Its warm
 * number is the floor for "answer a payload-v2 event", which is what the adapters are billed
 * against.
 *
 *   node <bundled handler-raw.js> <cold|warm>
 */

import { drive, isUser, type LambdaEventFixture } from "./_drive.ts"

// See handler-nifra.ts: first module-body statement.
const initMs = performance.now()

const USER_ID = /^\/users\/([^/?]+)$/

await drive("raw", initMs, () => {
  return async (event: LambdaEventFixture) => {
    const method = event.requestContext.http.method
    if (method === "POST" && event.rawPath === "/users") {
      let parsed: unknown
      try {
        parsed = JSON.parse(event.body ?? "")
      } catch {
        return { statusCode: 400 }
      }
      if (!isUser(parsed)) return { statusCode: 400 }
      return { statusCode: 200, body: JSON.stringify({ id: "1", name: parsed.name }) }
    }
    const match = USER_ID.exec(event.rawPath)
    if (match !== null) return { statusCode: 200, body: JSON.stringify({ id: match[1] }) }
    return { statusCode: 404 }
  }
})
