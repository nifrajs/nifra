import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DATA_HEADER, PREFETCH_HEADER } from "../src/router.ts"
import { nextSlowAbort, probe } from "./fixtures/ppr/app/lib/probe.ts"
import { type PprApp, startPprApp } from "./fixtures/ppr/app/server.ts"

let app: PprApp
beforeAll(async () => {
  app = await startPprApp()
})
afterAll(async () => {
  await app.stop()
})

const firstLine = (text: string): { readonly boundaries?: Record<string, unknown> } =>
  JSON.parse(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")))

describe("PPR app: requests that are not a streamed document", () => {
  test("a prefetch gets the shell data and empty hosts, and starts no hole", async () => {
    const before = probe.slowStarted
    const res = await fetch(`${app.origin}/p/7`, {
      headers: { [DATA_HEADER]: "1", [PREFETCH_HEADER]: "1" },
    })
    const payload = firstLine(await res.text())
    expect(probe.slowStarted).toBe(before)
    expect(payload.boundaries?.slow).toEqual({
      name: "slow",
      mode: "dynamic",
      status: "pending",
      ppr: true,
    })
  })

  test("a data request runs its holes as deferred values the request's abort cancels", async () => {
    const started = probe.slowStarted
    const client = new AbortController()
    const res = await fetch(`${app.origin}/p/7?slow=60000`, {
      headers: { [DATA_HEADER]: "1" },
      signal: client.signal,
    })
    const reader = res.body?.getReader()
    const head = new TextDecoder().decode((await reader?.read())?.value)
    expect(probe.slowStarted).toBe(started + 1)
    expect(firstLine(head).boundaries?.slow).toMatchObject({ status: "pending" })
    const aborted = nextSlowAbort()
    client.abort()
    await aborted
  })

  test("a listed bot gets the blocking render with every hole filled", async () => {
    const res = await fetch(`${app.origin}/p/7`, { headers: { "user-agent": "Slackbot 1.0" } })
    const html = await res.text()
    expect(html).toContain('<p id="slow">slow <!-- -->50</p>')
    expect(html).toContain('id="cart"')
    expect(html.includes("nifra-ppr:")).toBe(false)
  })
})
