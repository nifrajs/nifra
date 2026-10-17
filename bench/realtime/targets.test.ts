import { expect, test } from "bun:test"
import { echoRtt, fanOut, sseThroughput } from "./driver.ts"

async function withTarget(file: string, run: (base: string) => Promise<void>): Promise<void> {
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reserved.port
  reserved.stop(true)
  if (port === undefined) throw new Error("could not reserve a fixture port")
  const base = `http://127.0.0.1:${port}`
  const proc = Bun.spawn(["bun", `${import.meta.dir}/${file}`, String(port)], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const errors = new Response(proc.stderr).text()
  try {
    const deadline = Date.now() + 10_000
    let ready = false
    while (Date.now() < deadline && proc.exitCode === null) {
      try {
        const response = await fetch(`${base}/fire?p=0`, { signal: AbortSignal.timeout(200) })
        await response.arrayBuffer()
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        // The fixture has not bound its port yet.
      }
      await Bun.sleep(20)
    }
    if (!ready) throw new Error(`fixture did not become ready: ${file}`)
    await run(base)
  } finally {
    proc.kill()
    await proc.exited
    await errors
  }
}

test("Elysia sends exactly the requested echo and broadcast messages", async () => {
  await withTarget("serve-elysia.ts", async (base) => {
    expect((await echoRtt(base.replace("http:", "ws:") + "/echo", 1000)).msgs).toBe(1000)
    const result = await fanOut(base, base.replace("http:", "ws:") + "/room", 10, 3)
    expect(result.delivered).toBe(30)
  })
})

test("Nifra's finite fixture budget delivers the complete 200000-event burst", async () => {
  await withTarget("serve-nifra.ts", async (base) => {
    expect((await sseThroughput(base, 200_000)).events).toBe(200_000)
  })
})
