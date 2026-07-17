import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { createMetricsRegistry, metrics } from "../src/metrics.ts"

function makeApp(registry = createMetricsRegistry()) {
  return server()
    .use(metrics({ registry }))
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/boom", () => {
      throw new Error("kaboom")
    })
}

async function scrape(app: { fetch(r: Request): Response | Promise<Response> }): Promise<string> {
  const res = await app.fetch(new Request("http://t/metrics"))
  return res.text()
}

describe("metrics()", () => {
  test("records RED series labeled by the matched route TEMPLATE, not the raw path", async () => {
    const app = makeApp()
    await app.fetch(new Request("http://t/users/1"))
    await app.fetch(new Request("http://t/users/2")) // same template → same series
    const text = await scrape(app)

    expect(text).toContain(
      'nifra_http_requests_total{method="GET",route="/users/:id",status="200"} 2',
    )
    // one series for the template, never per-id
    expect(text).not.toContain('route="/users/1"')
    expect(text).toContain("# TYPE nifra_http_request_duration_seconds histogram")
    expect(text).toContain("nifra_http_request_duration_seconds_count{")
    expect(text).toContain('le="+Inf"')
  })

  test("counts a 500 with its status label and an unmatched path as route=unmatched", async () => {
    const app = makeApp()
    await app.fetch(new Request("http://t/boom"))
    await app.fetch(new Request("http://t/nope"))
    const text = await scrape(app)
    expect(text).toContain('route="/boom",status="500"')
    expect(text).toContain('route="unmatched",status="404"')
  })

  test("the /metrics scrape endpoint does not count itself", async () => {
    const app = makeApp()
    await scrape(app)
    const text = await scrape(app)
    expect(text).not.toContain('route="/metrics"')
  })

  test("exposes Prometheus content-type", async () => {
    const app = makeApp()
    const res = await app.fetch(new Request("http://t/metrics"))
    expect(res.headers.get("content-type")).toContain("text/plain")
    expect(res.headers.get("content-type")).toContain("version=0.0.4")
  })

  test("in-flight gauge returns to zero after requests settle", async () => {
    const app = makeApp()
    await app.fetch(new Request("http://t/users/1"))
    const text = await scrape(app)
    expect(text).toContain('nifra_http_requests_in_flight{method="GET"} 0')
  })

  test("custom app metrics on a shared registry render at /metrics", async () => {
    const registry = createMetricsRegistry()
    const logins = registry.counter("app_logins_total", "Logins.")
    const app = makeApp(registry)
    logins.inc({ method: "password" })
    logins.inc({ method: "password" })
    logins.inc({ method: "oauth" })
    const text = await scrape(app)
    expect(text).toContain("# TYPE app_logins_total counter")
    expect(text).toContain('app_logins_total{method="password"} 2')
    expect(text).toContain('app_logins_total{method="oauth"} 1')
  })
})

describe("metrics registry primitives", () => {
  test("histogram renders cumulative buckets + sum + count", () => {
    const registry = createMetricsRegistry()
    const h = registry.histogram("lat", [0.1, 0.5, 1], "Latency.")
    h.observe(0.05)
    h.observe(0.3)
    h.observe(2)
    const text = registry.render()
    expect(text).toContain('lat_bucket{le="0.1"} 1') // only 0.05
    expect(text).toContain('lat_bucket{le="0.5"} 2') // 0.05, 0.3
    expect(text).toContain('lat_bucket{le="1"} 2')
    expect(text).toContain('lat_bucket{le="+Inf"} 3')
    expect(text).toContain("lat_count 3")
  })

  test("label values are escaped", () => {
    const registry = createMetricsRegistry()
    registry.counter("c").inc({ path: 'a"b\\c' })
    expect(registry.render()).toContain('c{path="a\\"b\\\\c"} 1')
  })

  test("rejects an invalid metric name", () => {
    const registry = createMetricsRegistry()
    expect(() => registry.counter("1bad")).toThrow(/invalid metric name/)
  })
})
