/** `ws.close()` and the `close` callback on Node itself, with the fixture the Bun and Deno suites run. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"
import {
  closeArgsAnswers,
  closeArgsRoute,
  closeReportRoute,
  closeReports,
  FORBIDDEN_CLOSES,
  REPORT_CAP,
  SERVER_CLOSE_REPORTS,
} from "../../core/test/ws-close-args.ts"

test("a close RFC 6455 forbids throws a RangeError and leaves the socket open", async () => {
  const running = await serve(closeArgsRoute(server().use(websocket())), {
    port: 0,
    hostname: "127.0.0.1",
  })
  try {
    assert.deepEqual(await closeArgsAnswers(running.port), {
      answers: FORBIDDEN_CLOSES.map(() => "range"),
      closed: { code: 4000, reason: "ok" },
    })
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("close is given the server's own close, and 1009 for a message over ws's cap", async () => {
  const app = server({ wsMaxPayloadBytes: REPORT_CAP }).use(websocket())
  const next = closeReportRoute(app)
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.deepEqual(await closeReports(running.port, next), [...SERVER_CLOSE_REPORTS])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
