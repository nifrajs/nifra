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

test("a codec given without a registry gets one derived, and reused across clients", async () => {
  // Passing only a codec is the ergonomic form: the client has to build a registry pairing it with
  // the plain JSON fallback. That derived registry is cached per codec, so a second client over the
  // same codec must negotiate identically rather than silently building a divergent one.
  const rich = richWireCodec()
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
    .use(transportCodecs(createTransportCodecRegistry([plainJsonCodec, rich])))
    .post("/echo", { body: bodySchema }, (c) => c.body)

  const value = { at: new Date("2026-05-06T00:00:00.000Z") }
  const first = inProcessClient(app, { transport: { codec: rich } })
  const second = inProcessClient(app, { transport: { codec: rich } })

  for (const api of [first, second]) {
    const response = await api.echo.post(value)
    expect(response.ok).toBe(true)
    if (response.ok) expect(response.data).toEqual(value)
  }
})
