import { describe, expect, test } from "bun:test"
import { toLambdaHandler, toNetlifyHandler, toVercelHandler } from "../src/server.ts"

const app = {
  async fetch(request: Request): Promise<Response> {
    return Response.json({ method: request.method, url: request.url, body: await request.text() })
  },
}

describe("platform adapters", () => {
  test("adapts Vercel Edge's Web handler shape", async () => {
    const response = await toVercelHandler(app)(new Request("https://example.test/hello"))
    expect(await response.json()).toEqual({
      method: "GET",
      url: "https://example.test/hello",
      body: "",
    })
  })

  test("adapts Netlify events and preserves base64 bodies", async () => {
    const response = await toNetlifyHandler(app)({
      httpMethod: "POST",
      path: "/hello",
      rawQuery: "name=Ada",
      headers: { host: "example.test", "content-type": "text/plain" },
      body: btoa("payload"),
      isBase64Encoded: true,
    })
    const body = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(response.body)))
    expect(response.statusCode).toBe(200)
    expect(body).toEqual({
      method: "POST",
      url: "https://example.test/hello?name=Ada",
      body: "payload",
    })
    expect(response.isBase64Encoded).toBe(true)
  })

  test("adapts both API Gateway v2 and v1 events", async () => {
    const handler = toLambdaHandler(app)
    const v2 = await handler({
      version: "2.0",
      rawPath: "/v2",
      rawQueryString: "x=1",
      headers: { host: "example.test" },
      requestContext: { http: { method: "GET" } },
    })
    const v1 = await handler({
      httpMethod: "POST",
      path: "/v1",
      headers: { host: "example.test" },
      queryStringParameters: { x: "2" },
      body: "body",
    })
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(v2.body))).url).toBe(
      "https://example.test/v2?x=1",
    )
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(v1.body)))).toMatchObject({
      method: "POST",
      url: "https://example.test/v1?x=2",
      body: "body",
    })
  })

  // A response setting more than one cookie is the ordinary case (session + CSRF, or a rotation that
  // clears the old one). `Headers.forEach` collapses repeated set-cookie into one comma-joined value
  // and a plain record keeps one key, so the naive envelope silently dropped a cookie - which reads
  // as an intermittent logout in production and nowhere else.
  const cookieApp = {
    async fetch(): Promise<Response> {
      const headers = new Headers()
      headers.append("set-cookie", "session=abc; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT")
      headers.append("set-cookie", "csrf=xyz; Path=/; HttpOnly")
      return new Response("ok", { headers })
    },
  }
  const bothCookies = [
    "session=abc; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
    "csrf=xyz; Path=/; HttpOnly",
  ]

  test("API Gateway v2 carries every cookie in its dedicated array", async () => {
    const result = await toLambdaHandler(cookieApp)({
      version: "2.0",
      rawPath: "/",
      rawQueryString: "",
      requestContext: { domainName: "api.example.test", http: { method: "GET", path: "/" } },
    })
    expect(result.cookies).toEqual(bothCookies)
    expect(result.headers["set-cookie"]).toBeUndefined()
  })

  test("API Gateway v1 and Netlify carry every cookie in multiValueHeaders", async () => {
    const v1 = await toLambdaHandler(cookieApp)({ httpMethod: "GET", path: "/" })
    expect(v1.multiValueHeaders?.["set-cookie"]).toEqual(bothCookies)
    expect(v1.headers["set-cookie"]).toBeUndefined()
    expect(v1.cookies).toBeUndefined()

    const netlify = await toNetlifyHandler(cookieApp)({ httpMethod: "GET", path: "/" })
    expect(netlify.multiValueHeaders?.["set-cookie"]).toEqual(bothCookies)
    expect(netlify.headers["set-cookie"]).toBeUndefined()
  })

  test("a cookie-free response carries neither channel", async () => {
    const result = await toLambdaHandler(app)({ httpMethod: "GET", path: "/" })
    expect(result.cookies).toBeUndefined()
    expect(result.multiValueHeaders).toBeUndefined()
  })
})
