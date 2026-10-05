import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { ipRestriction } from "../src/index.ts"

describe("ipRestriction()", () => {
  test("allows matching IPv4 CIDRs and blocks non-matches", async () => {
    const app = (ip: string) =>
      server()
        .use(ipRestriction({ allow: ["10.0.0.0/8"], clientIp: () => ip }))
        .get("/", () => ({ ok: true }))

    expect((await app("10.2.3.4").fetch(new Request("http://x/"))).status).toBe(200)
    expect((await app("192.168.1.1").fetch(new Request("http://x/"))).status).toBe(403)
  })

  test("deny rules win over allow rules", async () => {
    const app = server()
      .use(
        ipRestriction({
          allow: ["10.0.0.0/8"],
          deny: ["10.0.0.13"],
          clientIp: () => "10.0.0.13",
        }),
      )
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/"))).status).toBe(403)
  })

  test("supports IPv6 CIDR matching", async () => {
    const app = server()
      .use(ipRestriction({ allow: ["2001:db8::/32"], clientIp: () => "2001:db8::1" }))
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
  })

  test("fails closed when X-Forwarded-For is untrusted", async () => {
    const app = server()
      .use(ipRestriction({ allow: ["1.2.3.4"] }))
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(
      new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4" } }),
    )
    expect(res.status).toBe(403)
  })

  test("defaults to the server-resolved client IP and fails closed without one", async () => {
    const app = server()
      .use(ipRestriction({ allow: ["10.0.0.0/8"] }))
      .get("/", () => ({ ok: true }))
    const spoofed = new Request("http://x/", { headers: { "x-forwarded-for": "10.1.1.1" } })
    expect((await app.fetch(spoofed.clone(), { clientIp: "10.2.2.2" })).status).toBe(200)
    expect((await app.fetch(spoofed.clone(), { clientIp: "8.8.8.8" })).status).toBe(403)
    expect((await app.fetch(spoofed.clone())).status).toBe(403)

    // An explicit proxy option never falls back to the socket peer (the proxy's own address).
    const proxied = server()
      .use(ipRestriction({ allow: ["10.0.0.0/8"], trustedProxies: 1 }))
      .get("/", () => ({ ok: true }))
    expect((await proxied.fetch(new Request("http://x/"), { clientIp: "10.0.0.1" })).status).toBe(
      403,
    )
  })

  test("an IPv4 peer reported as IPv4-mapped IPv6 meets the IPv4 rules", async () => {
    // Bun and Node report every IPv4 peer of their default dual-stack listener this way.
    const denied = server()
      .use(ipRestriction({ deny: ["203.0.113.0/24"] }))
      .get("/", () => ({ ok: true }))
    const from = (app: typeof denied, clientIp: string) =>
      app.fetch(new Request("http://x/"), { clientIp })
    expect((await from(denied, "::ffff:203.0.113.5")).status).toBe(403)
    expect((await from(denied, "::FFFF:cb00:7105")).status).toBe(403)
    expect((await from(denied, "::ffff:198.51.100.1")).status).toBe(200)

    const allowed = server()
      .use(ipRestriction({ allow: ["10.0.0.0/8", "::ffff:192.168.0.0/112"] }))
      .get("/", () => ({ ok: true }))
    expect((await from(allowed, "::ffff:10.1.2.3")).status).toBe(200)
    expect((await from(allowed, "192.168.4.4")).status).toBe(200)
    expect((await from(allowed, "::ffff:8.8.8.8")).status).toBe(403)
    expect(() => ipRestriction({ allow: ["::ffff:10.0.0.0/64"] })).toThrow("invalid CIDR prefix")
  })

  test("extracts the trusted proxy hop and ignores spoofed left prefixes", async () => {
    const app = server()
      .use(ipRestriction({ allow: ["1.2.3.4"], trustedProxies: 1 }))
      .get("/", () => ({ ok: true }))

    const ok = await app.fetch(
      new Request("http://x/", { headers: { "x-forwarded-for": "evil, 1.2.3.4" } }),
    )
    const blocked = await app.fetch(
      new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }),
    )
    expect(ok.status).toBe(200)
    expect(blocked.status).toBe(403)
  })

  test("validates construction", () => {
    expect(() => ipRestriction({ allow: [] })).toThrow(/at least one/)
    expect(() => ipRestriction({ allow: ["10.0.0.0/99"] })).toThrow(/CIDR/)
    expect(() => ipRestriction({ allow: ["bad"] })).toThrow(/invalid/)
    expect(() => ipRestriction({ allow: ["127.0.0.1"], trustedProxies: -1 })).toThrow(
      /trustedProxies/,
    )
    expect(() => ipRestriction({ allow: ["127.0.0.1"], header: "" })).toThrow(/header/)
  })
})
