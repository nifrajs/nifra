import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { resolveClientIp } from "../src/server/client-ip.ts"

/** Drive an app's clientIp resolution through the real `fetch(req, platform)` seam an adapter uses. */
function clientIpOf(
  app: { fetch(req: Request, platform?: { clientIp?: string }): Response | Promise<Response> },
  headers: Record<string, string>,
  peer: string | undefined,
): Promise<unknown> {
  const req = new Request("http://t/ip", { headers })
  return Promise.resolve(app.fetch(req, peer === undefined ? undefined : { clientIp: peer })).then(
    (res) => res.json(),
  )
}

const ipApp = (options?: Parameters<typeof server>[0]) =>
  server(options).get("/ip", (c) => ({ ip: c.clientIp ?? null }))

describe("resolveClientIp (unit)", () => {
  const req = (xff?: string, real?: string): Request =>
    new Request("http://t", {
      headers: {
        ...(xff !== undefined ? { "x-forwarded-for": xff } : {}),
        ...(real !== undefined ? { "x-real-ip": real } : {}),
      },
    })

  test("no trust → the raw socket peer, never a header", () => {
    expect(resolveClientIp("9.9.9.9", req("1.1.1.1"), undefined)).toBe("9.9.9.9")
    expect(resolveClientIp(undefined, req("1.1.1.1"), undefined)).toBeUndefined()
  })

  test("trustedHops: 0 → the socket peer (one trusted proxy = none)", () => {
    expect(resolveClientIp("9.9.9.9", req("1.1.1.1, 2.2.2.2"), { trustedHops: 0 })).toBe("9.9.9.9")
  })

  test("trustedHops: n → the caller past n trusted proxies in XFF + peer", () => {
    // chain = [1.1.1.1 (client), 2.2.2.2 (proxy1), 9.9.9.9 (peer=proxy2)]
    const r = req("1.1.1.1, 2.2.2.2")
    expect(resolveClientIp("9.9.9.9", r, { trustedHops: 1 })).toBe("2.2.2.2")
    expect(resolveClientIp("9.9.9.9", r, { trustedHops: 2 })).toBe("1.1.1.1")
  })

  test("trustedHops beyond the chain length fails closed (undefined)", () => {
    expect(resolveClientIp("9.9.9.9", req("1.1.1.1"), { trustedHops: 5 })).toBeUndefined()
  })

  test("header trust → the named header's first value", () => {
    expect(resolveClientIp("9.9.9.9", req(undefined, "3.3.3.3"), { header: "x-real-ip" })).toBe(
      "3.3.3.3",
    )
    expect(resolveClientIp("9.9.9.9", req("7.7.7.7, 8.8.8.8"), { header: "x-forwarded-for" })).toBe(
      "7.7.7.7",
    )
  })

  test("header trust with the header absent → undefined, NOT the peer (fail closed)", () => {
    expect(resolveClientIp("9.9.9.9", req(), { header: "x-real-ip" })).toBeUndefined()
  })
})

describe("c.clientIp (integration through fetch)", () => {
  test("default: the socket peer the adapter supplied", async () => {
    expect(await clientIpOf(ipApp(), {}, "9.9.9.9")).toEqual({ ip: "9.9.9.9" })
  })

  test("default: undefined when the runtime exposes no socket peer", async () => {
    expect(await clientIpOf(ipApp(), { "x-forwarded-for": "1.1.1.1" }, undefined)).toEqual({
      ip: null,
    })
  })

  test("trustedHops derives the caller from XFF + peer", async () => {
    const app = ipApp({ clientIp: { trustedHops: 1 } })
    expect(await clientIpOf(app, { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "9.9.9.9")).toEqual({
      ip: "2.2.2.2",
    })
  })

  test("header trust reads the edge-set header", async () => {
    const app = ipApp({ clientIp: { header: "x-real-ip" } })
    expect(await clientIpOf(app, { "x-real-ip": "3.3.3.3" }, "9.9.9.9")).toEqual({ ip: "3.3.3.3" })
  })

  test("header trust never falls back to the forgeable peer when absent", async () => {
    const app = ipApp({ clientIp: { header: "x-real-ip" } })
    expect(await clientIpOf(app, {}, "9.9.9.9")).toEqual({ ip: null })
  })

  test("clientIp survives into derive/beforeHandle (the same resolved value)", async () => {
    const app = server({ clientIp: { trustedHops: 1 } })
      .derive((c) => ({ caller: c.clientIp }))
      .get("/ip", (c) => ({ ip: c.caller ?? null }))
    const req = new Request("http://t/ip", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })
    const res = await app.fetch(req, { clientIp: "9.9.9.9" })
    expect(await res.json()).toEqual({ ip: "2.2.2.2" })
  })

  test("Bun listen() supplies the real socket peer end-to-end", async () => {
    // A trust declaration routes off the fused native table through the fetch lane, where the Bun
    // adapter's `server.requestIP` peer is resolved - proving the whole path over a real socket.
    const app = ipApp({ clientIp: { trustedHops: 0 } })
    const running = app.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/ip`)
      const body = (await res.json()) as { ip: string | null }
      // Bun reports the loopback peer as the IPv4-mapped IPv6 form on some platforms.
      expect(body.ip).not.toBeNull()
      expect(String(body.ip)).toContain("127.0.0.1")
    } finally {
      running.stop(true)
    }
  })
})
