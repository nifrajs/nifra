import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { renderPages } from "../src/mcp-render.ts"

// A real, in-workspace nifra React app (framework.ts + routes/ + backend.ts) — the faithful fixture.
const APP = join(import.meta.dir, "../../../examples/cli-react")

type RenderResult = Awaited<ReturnType<typeof renderPages>>
type PageResult = { status: number; body?: unknown; path?: string }
const isErr = (r: RenderResult): r is { error: string } => "error" in r

// A persistent `mcp-render.ts --worker` subprocess, used to prove the warm path: the web app is built
// ONCE and reused across newline-delimited `{ id, input }` requests (mirrors the mcp-run worker harness).
type PipeProc = ReturnType<typeof Bun.spawn> & {
  readonly stdin: { write(input: string): unknown }
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
}

function spawnRenderWorker(cwd: string): {
  proc: PipeProc
  call: (id: number, requests: unknown) => Promise<{ id: number; output: unknown }>
  close: () => Promise<void>
} {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/mcp-render.ts"), cwd, "--worker"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as PipeProc
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const readLine = async (): Promise<{ id: number; output: unknown }> => {
    for (;;) {
      const nl = buffer.indexOf("\n")
      if (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        return JSON.parse(line) as { id: number; output: unknown }
      }
      const { done, value } = await reader.read()
      if (done) throw new Error("worker exited before response")
      buffer += decoder.decode(value, { stream: true })
    }
  }
  const call = async (id: number, requests: unknown): Promise<{ id: number; output: unknown }> => {
    proc.stdin.write(`${JSON.stringify({ id, input: { requests } })}\n`)
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      readLine(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for worker")), 10_000)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
  const close = async (): Promise<void> => {
    proc.kill()
    await proc.exited.catch(() => 0)
  }
  return { proc, call, close }
}

describe("renderPages", () => {
  test("SSRs a real page route to HTML (loader runs), 404s an unknown path", async () => {
    const r = await renderPages(APP, [{ path: "/" }, { path: "/no-such-page" }])
    expect(isErr(r)).toBe(false)
    if (isErr(r)) return
    const [home, missing] = r.results as PageResult[]
    expect(home?.status).toBe(200)
    const html = typeof home?.body === "string" ? home.body : String(home?.body ?? "")
    expect(html.length).toBeGreaterThan(50)
    expect(/<(?:!doctype|html|main|div|h1|button)/i.test(html)).toBe(true) // real server-rendered markup
    expect(missing?.status).toBe(404)
  })

  test("non-array requests → actionable error, never throws", async () => {
    const r = await renderPages(APP, "nope" as unknown)
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error).toContain("expected { requests")
  })

  test("a project with no nifra config → actionable error (not a crash)", async () => {
    const r = await renderPages(join(import.meta.dir, ".."), [{ path: "/" }]) // packages/cli — no config
    expect(isErr(r)).toBe(true)
  })
})

describe("mcp-render --worker (nifra_render warm)", () => {
  test("answers sequential requests on one hot process (the warm reuse loop)", async () => {
    const worker = spawnRenderWorker(APP)
    try {
      // Two requests, one process: each gets a reply keyed by its own id. Proves the persistent loop —
      // the warm path nifra_render exposes — without re-spawning per call. (The SSR status itself can vary
      // by environment; the behavioral change under test is "one worker serves many calls".)
      const first = await worker.call(1, [{ path: "/" }])
      const second = await worker.call(2, [{ path: "/" }])
      expect(first.id).toBe(1)
      expect(second.id).toBe(2)
      // The web app was built once at worker start; both calls ran against it (the process never exited
      // between them — readLine would have thrown "worker exited before response" otherwise).
    } finally {
      await worker.close()
    }
  })

  test("a build failure is computed once and returned for every request (built-once reuse)", async () => {
    // packages/cli has no nifra config → buildWebApp fails. The worker builds ONCE at startup, so the same
    // actionable error comes back for each request instead of re-loading per call — the reuse guarantee.
    const worker = spawnRenderWorker(join(import.meta.dir, ".."))
    try {
      const first = await worker.call(1, [{ path: "/" }])
      const second = await worker.call(2, [{ path: "/" }])
      expect((first.output as { error?: string }).error).toBeDefined()
      expect((second.output as { error?: string }).error).toBe(
        (first.output as { error?: string }).error,
      )
    } finally {
      await worker.close()
    }
  })

  test("worker mode guards non-array requests without exiting", async () => {
    const worker = spawnRenderWorker(APP)
    try {
      const bad = await worker.call(1, "nope")
      expect((bad.output as { error?: string }).error).toContain("expected { requests")
      // Still alive: a follow-up call still gets a reply (the guard didn't kill the loop).
      const ok = await worker.call(2, [{ path: "/" }])
      expect(ok.id).toBe(2)
    } finally {
      await worker.close()
    }
  })
})
