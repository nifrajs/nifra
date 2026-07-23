import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { listenOrExplain, portInUseMessage } from "../src/dev-port.ts"

// A dev server that can't bind is the WORST silent failure in the dev loop: the previous `nifra dev` is
// still listening, so the browser keeps rendering the old build and the symptom presents as "edits no
// longer reach SSR". These tests pin the behaviour that makes the real cause visible.

test("EADDRINUSE rejects with the named nifra explanation (not Node's internal throw)", async () => {
  const holder = createServer(() => {})
  await new Promise<void>((done) => holder.listen(0, done))
  const port = (holder.address() as { port: number }).port
  try {
    const second = createServer(() => {})
    const promise = listenOrExplain(second, port)
    await expect(promise).rejects.toThrow(`port ${port} is already in use`)
    // The stale-output cause is spelled out — that sentence is the whole point of the guard.
    await expect(promise).rejects.toThrow(/PREVIOUS build/)
    // Both escape hatches are given, with the port substituted so they're copy-pasteable.
    await expect(promise).rejects.toThrow(new RegExp(`lsof -ti:${port}`))
    await expect(promise).rejects.toThrow(new RegExp(`--port ${port + 1}`))
    second.close()
  } finally {
    holder.close()
  }
})

test("a free port resolves and leaves no lingering error listener", async () => {
  const server = createServer(() => {})
  await listenOrExplain(server, 0)
  // The guard must be detached after a successful bind: still attached, it would swallow a later server
  // error into an already-settled promise instead of surfacing it.
  expect(server.listenerCount("error")).toBe(0)
  server.close()
})

test("a non-EADDRINUSE bind failure passes through unchanged (no misleading port advice)", async () => {
  const fake = {
    listen(_port: number, _cb: () => void) {
      queueMicrotask(() =>
        this.handler?.(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })),
      )
    },
    handler: undefined as ((err: unknown) => void) | undefined,
    once(_event: "error", cb: (err: unknown) => void) {
      this.handler = cb
    },
    removeListener() {
      this.handler = undefined
    },
  }
  const promise = listenOrExplain(fake, 3000)
  await expect(promise).rejects.toThrow(/EACCES/)
  await expect(promise).rejects.not.toThrow(/already in use/)
})

test("a non-Error rejection value is still surfaced as an Error", async () => {
  const fake = {
    listen(_port: number, _cb: () => void) {
      queueMicrotask(() => this.handler?.("socket exploded"))
    },
    handler: undefined as ((err: unknown) => void) | undefined,
    once(_event: "error", cb: (err: unknown) => void) {
      this.handler = cb
    },
    removeListener() {
      this.handler = undefined
    },
  }
  await expect(listenOrExplain(fake, 3000)).rejects.toThrow("socket exploded")
})

test("portInUseMessage names the port and offers the next one", () => {
  const message = portInUseMessage(5173)
  expect(message).toContain("port 5173 is already in use")
  expect(message).toContain("--port 5174")
})
