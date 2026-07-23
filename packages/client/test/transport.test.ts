import { expect, test } from "bun:test"
import { server } from "@nifrajs/core/server"
import { createTransportCodecRegistry, plainJsonCodec } from "@nifrajs/core/transport-codec"
import { richWireCodec } from "@nifrajs/core/transport-codec-rich"
import { transportCodecs } from "@nifrajs/core/transport-plugin"
import { inProcessClient } from "../src/client.ts"

test("typed client shares a negotiated rich codec with the HTTP server", async () => {
  const rich = richWireCodec()
  const registry = createTransportCodecRegistry([plainJsonCodec, rich])
  const bodySchema = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate(value: unknown) {
        return value !== null &&
          typeof value === "object" &&
          (value as { at?: unknown }).at instanceof Date
          ? { value: value as { at: Date } }
          : { issues: [{ message: "expected date" }] }
      },
    },
  }
  const app = server()
    .use(transportCodecs(registry))
    .post("/echo", { body: bodySchema }, (c) => c.body)
  const api = inProcessClient(app, { transport: { codec: rich, registry } })
  const value = { at: new Date("2026-03-04T00:00:00.000Z") }
  const response = await api.echo.post(value)
  expect(response.ok).toBe(true)
  if (response.ok) expect(response.data).toEqual(value)
})
