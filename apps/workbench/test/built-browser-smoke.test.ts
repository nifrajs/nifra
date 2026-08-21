/**
 * Proves the browser artifact the operator actually loads: build the bundle, boot the replay launcher
 * (no Pi process required), and fetch the served index and JavaScript from the real server. Asserts
 * the JavaScript MIME and module wiring, and that the bundler fully resolved `@nifrajs/agent-app` -
 * a stray bare import would mean the browser tried to load a bare specifier and the page was broken.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..")
let origin: string
let launcher: ReturnType<typeof Bun.spawn> | undefined

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: packageRoot, stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`command failed (${code}): ${cmd.join(" ")}\n${err}`)
  }
}

beforeAll(async () => {
  await run(["bun", "run", "build:browser"])
  launcher = Bun.spawn(
    ["bun", "run", "src/server.ts", "--backend", "replay", "--ui-port", "0", "--rpc-port", "0"],
    { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
  )
  origin = await waitForUrl(launcher)
}, 60_000)

afterAll(() => {
  launcher?.kill()
})

async function waitForUrl(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const match = buffer.match(/Nifra Workbench: (http:\/\/\S+)/)
    if (match?.[1]) {
      reader.releaseLock()
      return new URL(match[1]).origin
    }
  }
  reader.releaseLock()
  throw new Error("workbench launcher did not report a URL")
}

describe("built workbench browser artifact", () => {
  test("serves the JavaScript bundle with a module MIME type", async () => {
    const response = await fetch(`${origin}/app.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/javascript")
    const body = await response.text()
    // The SDK is bundled in, not left as a runtime bare specifier the browser cannot resolve.
    expect(body).not.toMatch(/from\s*["']@nifrajs\/agent-app["']/)
    expect(body).not.toMatch(/import\s*["']@nifrajs\/agent-app["']/)
    // And the client machinery is present, proving the dependency was actually inlined.
    expect(body).toContain("createSession")
  })

  test("serves an index that loads the bundle as a module", async () => {
    const response = await fetch(`${origin}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain('type="module"')
    expect(html).toContain("/app.js")
  })
})
