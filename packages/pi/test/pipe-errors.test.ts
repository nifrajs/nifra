import { expect, spyOn, test } from "bun:test"
import { PiBackend } from "../src/index.ts"

const idlePi = 'process.stdin.on("data", () => {})'

async function session(script = idlePi) {
  const spawning = spyOn(Bun, "spawn")
  const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", script] })
  try {
    await backend.createSession({ cwd: process.cwd(), sessionId: "pipe-errors" })
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The spy records createSession's Bun.spawn subprocess; its writable stdin is checked below before use.
    const subprocess = spawning.mock.results.at(-1)?.value as Bun.Subprocess | undefined
    if (
      subprocess === undefined ||
      subprocess.stdin === undefined ||
      typeof subprocess.stdin === "number" ||
      subprocess.stdin === null
    )
      throw new Error("expected a writable Pi subprocess")
    return { backend, sink: subprocess.stdin }
  } finally {
    spawning.mockRestore()
  }
}

async function drain(source: AsyncIterable<unknown>) {
  for await (const _ of source) {
    // Consume the public stream so a rejected RPC must settle the caller.
  }
}

test("a rejected prompt flush fails its turn and cancellation absorbs a closed pipe", async () => {
  const { backend, sink } = await session()
  const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" })
  const flushing = spyOn(sink, "flush").mockImplementation(() => Promise.reject(error))
  try {
    await expect(drain(backend.send({ sessionId: "pipe-errors", message: "hello" }))).rejects.toBe(
      error,
    )
    expect((await backend.snapshot("pipe-errors")).status).toBe("failed")
    const turn = backend.send({ sessionId: "pipe-errors", message: "cancel" })
    await backend.cancel("pipe-errors")
    await drain(turn)
    expect((await backend.snapshot("pipe-errors")).status).toBe("stopped")
  } finally {
    flushing.mockRestore()
    await backend.close("pipe-errors")
  }
})

test("a late prompt flush rejection cannot fail a completed or replacement turn", async () => {
  const { backend, sink } = await session()
  let rejectFlush: (error: Error) => void = () => {}
  const originalFlush = sink.flush.bind(sink)
  const flushing = spyOn(sink, "flush").mockImplementationOnce(
    () =>
      new Promise<number>((_, reject) => {
        rejectFlush = reject
      }),
  )
  flushing.mockImplementation(originalFlush)
  try {
    const previous = backend.send({ sessionId: "pipe-errors", message: "first" })
    await backend.cancel("pipe-errors")
    await drain(previous)
    flushing.mockRestore()
    const current = backend.send({ sessionId: "pipe-errors", message: "second" })
    rejectFlush(new Error("old pipe flush"))
    await Bun.sleep(0)
    expect((await backend.snapshot("pipe-errors")).status).toBe("running")
    await backend.cancel("pipe-errors")
    await drain(current)
  } finally {
    flushing.mockRestore()
    await backend.close("pipe-errors")
  }
})

test("a rejected unsupported-dialog response settles the active turn", async () => {
  const script = `process.stdin.on("data", (chunk) => {
    if (!String(chunk).includes('"type":"prompt"')) return
    process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "pick", method: "select" }) + "\\n")
  })`
  const { backend, sink } = await session(script)
  const originalWrite = sink.write.bind(sink)
  const originalFlush = sink.flush.bind(sink)
  const writing = spyOn(sink, "write").mockImplementationOnce(originalWrite)
  // The rejected response is a simulated transport failure, with no buffered OS write to tear down.
  writing.mockImplementation(() => 0)
  const flushing = spyOn(sink, "flush")
  // The first write sends the prompt; only the response to the unsupported dialog fails.
  flushing.mockImplementationOnce(originalFlush)
  flushing.mockImplementation(() => Promise.reject(new Error("closed dialog pipe")))
  try {
    await expect(
      drain(backend.send({ sessionId: "pipe-errors", message: "pick" })),
    ).rejects.toThrow("Pi could not receive the dialog response")
    expect((await backend.snapshot("pipe-errors")).status).toBe("failed")
  } finally {
    writing.mockRestore()
    flushing.mockRestore()
    await backend.close("pipe-errors")
  }
})
