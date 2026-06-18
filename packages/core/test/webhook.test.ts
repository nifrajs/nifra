import { describe, expect, test } from "bun:test"
import { verifyWebhook } from "../src/index.ts"

const enc = new TextEncoder()

async function sign(secret: string, payload: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", key, enc.encode(payload))
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")

const toBase64 = (buf: ArrayBuffer): string => {
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin)
}

const hmacHex = async (secret: string, payload: string): Promise<string> =>
  toHex(await sign(secret, payload))

function webhookRequest(body: string, headers: Record<string, string>): Request {
  return new Request("http://example.test/webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("verifyWebhook — Stripe preset", () => {
  const secret = "whsec_test_padded_to_at_least_32b"
  const payload = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" })

  const stripeHeader = async (t: number, p: string, s = secret): Promise<string> =>
    `t=${t},v1=${await hmacHex(s, `${t}.${p}`)}`

  test("a valid signature verifies and returns the raw payload", async () => {
    const req = webhookRequest(payload, { "stripe-signature": await stripeHeader(1000, payload) })
    const r = await verifyWebhook(req, secret, { provider: "stripe", now: 1000 })
    expect(r).toEqual({ ok: true, payload })
  })

  test("a tampered payload fails (invalid_signature)", async () => {
    const header = await stripeHeader(1000, payload)
    const req = webhookRequest(`${payload} `, { "stripe-signature": header }) // body mutated
    const r = await verifyWebhook(req, secret, { provider: "stripe", now: 1000 })
    expect(r).toEqual({ ok: false, reason: "invalid_signature" })
  })

  test("an old timestamp fails (timestamp_out_of_tolerance) even with a valid signature", async () => {
    const req = webhookRequest(payload, { "stripe-signature": await stripeHeader(1000, payload) })
    const r = await verifyWebhook(req, secret, { provider: "stripe", now: 2000 }) // 1000s > 300s window
    expect(r).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" })
  })

  test("a wrong secret fails (invalid_signature)", async () => {
    const req = webhookRequest(payload, { "stripe-signature": await stripeHeader(1000, payload) })
    const r = await verifyWebhook(req, "whsec_other_padded_to_at_least_32", {
      provider: "stripe",
      now: 1000,
    })
    expect(r).toEqual({ ok: false, reason: "invalid_signature" })
  })

  test("accepts either secret during a rotation (array of secrets)", async () => {
    // Signed with the OLD secret; the app now lists [new, old].
    const req = webhookRequest(payload, { "stripe-signature": await stripeHeader(1000, payload) })
    const r = await verifyWebhook(req, ["whsec_new_padded_to_at_least_32by", secret], {
      provider: "stripe",
      now: 1000,
    })
    expect(r).toEqual({ ok: true, payload })
  })

  test("a malformed header fails (malformed_signature)", async () => {
    const req = webhookRequest(payload, { "stripe-signature": "v1=deadbeef" }) // no t=
    const r = await verifyWebhook(req, secret, { provider: "stripe", now: 1000 })
    expect(r).toEqual({ ok: false, reason: "malformed_signature" })
  })

  test("a missing header fails (missing_signature)", async () => {
    const r = await verifyWebhook(webhookRequest(payload, {}), secret, {
      provider: "stripe",
      now: 1000,
    })
    expect(r).toEqual({ ok: false, reason: "missing_signature" })
  })
})

describe("verifyWebhook — GitHub preset", () => {
  const secret = "ghsecret_padded_to_at_least_32byt"
  const payload = JSON.stringify({ action: "opened" })

  test("a valid sha256= hex signature verifies", async () => {
    const sig = `sha256=${await hmacHex(secret, payload)}`
    const r = await verifyWebhook(webhookRequest(payload, { "x-hub-signature-256": sig }), secret, {
      provider: "github",
    })
    expect(r).toEqual({ ok: true, payload })
  })

  test("a wrong signature fails (invalid_signature)", async () => {
    const sig = `sha256=${await hmacHex("wrong", payload)}`
    const r = await verifyWebhook(webhookRequest(payload, { "x-hub-signature-256": sig }), secret, {
      provider: "github",
    })
    expect(r).toEqual({ ok: false, reason: "invalid_signature" })
  })

  test("a non-hex signature fails (malformed_signature)", async () => {
    const r = await verifyWebhook(
      webhookRequest(payload, { "x-hub-signature-256": "sha256=not-hex!!" }),
      secret,
      { provider: "github" },
    )
    expect(r).toEqual({ ok: false, reason: "malformed_signature" })
  })
})

describe("verifyWebhook — generic", () => {
  const secret = "s_padded_to_at_least_thirty_two_b"
  const payload = "raw-body"

  test("verifies a hex signature in a custom header", async () => {
    const r = await verifyWebhook(
      webhookRequest(payload, { "x-signature": await hmacHex(secret, payload) }),
      secret,
      { header: "X-Signature" }, // header match is case-insensitive
    )
    expect(r).toEqual({ ok: true, payload })
  })

  test("verifies a base64 signature", async () => {
    const sig = toBase64(await sign(secret, payload))
    const r = await verifyWebhook(webhookRequest(payload, { "x-sig": sig }), secret, {
      header: "x-sig",
      encoding: "base64",
    })
    expect(r).toEqual({ ok: true, payload })
  })

  test("throws when generic is used without a header (developer error)", async () => {
    const req = webhookRequest(payload, { "x-sig": "abcd" })
    await expect(verifyWebhook(req, secret)).rejects.toThrow(/header.*required/)
  })

  test("rejects an oversized body before verifying (payload_too_large)", async () => {
    const big = "x".repeat(64)
    const r = await verifyWebhook(webhookRequest(big, { "x-sig": "deadbeef" }), secret, {
      header: "x-sig",
      maxBytes: 8,
    })
    expect(r).toEqual({ ok: false, reason: "payload_too_large" })
  })

  test("rejects a malformed Content-Length (invalid_content_length)", async () => {
    const req = new Request("http://example.test/webhook", {
      method: "POST",
      body: "x",
      headers: { "x-sig": "deadbeef", "content-length": "not-a-number" },
    })
    const r = await verifyWebhook(req, secret, { header: "x-sig" })
    expect(r).toEqual({ ok: false, reason: "invalid_content_length" })
  })

  test("reads a body-less request as an empty payload (verifies over the empty string)", async () => {
    // A GET carries no body and no Content-Length, so the read takes the null-body path.
    const sig = await hmacHex(secret, "")
    const req = new Request("http://example.test/webhook", { headers: { "x-sig": sig } })
    expect(await verifyWebhook(req, secret, { header: "x-sig" })).toEqual({ ok: true, payload: "" })
  })

  test("uses the Content-Length fast path when a framed length is present", async () => {
    const sig = await hmacHex(secret, payload)
    const req = new Request("http://example.test/webhook", {
      method: "POST",
      body: payload,
      headers: { "x-sig": sig, "content-length": String(enc.encode(payload).byteLength) },
    })
    expect(await verifyWebhook(req, secret, { header: "x-sig" })).toEqual({ ok: true, payload })
  })

  test("reads a chunked (length-less) body via the streaming cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(payload))
        ctrl.close()
      },
    })
    const sig = await hmacHex(secret, payload)
    const req = new Request("http://example.test/webhook", {
      method: "POST",
      body: stream,
      headers: { "x-sig": sig },
      duplex: "half",
    } as RequestInit & { duplex: "half" }) // `duplex` is required for a stream body but missing from the DOM type
    expect(await verifyWebhook(req, secret, { header: "x-sig" })).toEqual({ ok: true, payload })
  })
})
