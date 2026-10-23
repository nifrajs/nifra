import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { JsonRpcRequest, JsonRpcResponse, McpTool } from "../src/protocol.ts"
import { createMcpServer } from "../src/server.ts"
import { runStdioTransport, type StdioTransportOptions, serveStdio } from "../src/stdio.ts"

/** An input stream the test pushes chunks into and ends, so no case depends on timing. */
function controlledInput(): {
  readonly input: AsyncIterable<Uint8Array | string>
  push(chunk: Uint8Array | string): void
  end(): void
} {
  const queue: (Uint8Array | string)[] = []
  let ended = false
  let wake: (() => void) | undefined
  const notify = (): void => {
    wake?.()
    wake = undefined
  }
  return {
    input: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (ended) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
    push(chunk) {
      queue.push(chunk)
      notify()
    },
    end() {
      ended = true
      notify()
    },
  }
}

function collector(): {
  readonly write: (chunk: string) => void
  readonly messages: () => unknown[]
} {
  let text = ""
  return {
    write: (chunk) => {
      text += chunk
    },
    messages: () =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Walk `keys` into a parsed message; a missing step is `undefined`. */
function pick(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined
    current = Reflect.get(current, key)
  }
  return current
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const line = (message: unknown): string => `${JSON.stringify(message)}\n`

async function transportOf(
  chunks: readonly (Uint8Array | string)[],
  options: Partial<StdioTransportOptions> = {},
): Promise<unknown[]> {
  const out = collector()
  await runStdioTransport({
    input: (async function* () {
      yield* chunks
    })(),
    output: out,
    onRequest: async (message) => ({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: message.method,
    }),
    ...options,
  })
  return out.messages()
}

const echo: McpTool = {
  name: "echo",
  description: "Echo the arguments",
  inputSchema: { type: "object" },
  handler: async (args) => JSON.stringify(args),
}

describe("runStdioTransport framing", () => {
  test("splits lines across and within chunks, ignoring blank lines and CRLF", async () => {
    const one = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" })
    const two = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" })
    const messages = await transportOf([one.slice(0, 5), `${one.slice(5)}\r\n\n  \n${two}\n`])
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: "a" },
      { jsonrpc: "2.0", id: 2, result: "b" },
    ])
  })

  test("reassembles a multi-byte character split between chunks", async () => {
    const bytes = new TextEncoder().encode(line({ jsonrpc: "2.0", id: 1, method: "café" }))
    const split = bytes.indexOf(0xc3) + 1
    const messages = await transportOf([bytes.subarray(0, split), bytes.subarray(split)])
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "café" }])
  })

  test("keeps a partial line intact when the stream reuses its chunk buffer", async () => {
    const encoded = new TextEncoder().encode(line({ jsonrpc: "2.0", id: 1, method: "reuse" }))
    const buffer = new Uint8Array(encoded.byteLength)
    const out = collector()
    await runStdioTransport({
      input: (async function* () {
        buffer.set(encoded.subarray(0, 10))
        yield buffer.subarray(0, 10)
        buffer.fill(0x20)
        buffer.set(encoded.subarray(10))
        yield buffer.subarray(0, encoded.byteLength - 10)
      })(),
      output: out,
      onRequest: async (message) => ({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: message.method,
      }),
    })
    expect(out.messages()).toEqual([{ jsonrpc: "2.0", id: 1, result: "reuse" }])
  })

  test("processes a final line that has no newline", async () => {
    const messages = await transportOf([JSON.stringify({ jsonrpc: "2.0", id: 7, method: "last" })])
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, result: "last" }])
  })

  test("answers an over-cap line once and keeps serving the next one", async () => {
    const big = line({ jsonrpc: "2.0", id: 1, method: "x".repeat(200) })
    const small = line({ jsonrpc: "2.0", id: 2, method: "ok" })
    const inOneChunk = await transportOf([big + small], { maxMessageBytes: 100 })
    const acrossChunks = await transportOf(
      [big.slice(0, 60), big.slice(60, 150), big.slice(150) + small],
      {
        maxMessageBytes: 100,
      },
    )
    const expected = [
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP message exceeded the size limit" },
      },
      { jsonrpc: "2.0", id: 2, result: "ok" },
    ]
    expect(inOneChunk).toEqual(expected)
    expect(acrossChunks).toEqual(expected)
  })

  test("a line exactly at the cap is accepted", async () => {
    const base = { jsonrpc: "2.0", id: 1, method: "" }
    const filler = 100 - JSON.stringify(base).length
    const exact = JSON.stringify({ ...base, method: "m".repeat(filler) })
    expect(new TextEncoder().encode(exact).byteLength).toBe(100)
    const messages = await transportOf([`${exact}\n`], { maxMessageBytes: 100 })
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "m".repeat(filler) }])
  })

  test("invalid UTF-8 and invalid JSON are parse errors", async () => {
    const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }
    const messages = await transportOf([new Uint8Array([0xff, 0xfe, 0x0a]), "{not json\n"])
    expect(messages).toEqual([parseError, parseError])
  })

  test("non-request shapes are Invalid Request and never reach the handler", async () => {
    const seen: JsonRpcRequest[] = []
    const messages = await transportOf(
      [
        "null\n",
        "[1]\n",
        "3\n",
        line({ jsonrpc: "2.0", id: 9, result: {} }),
        line({ jsonrpc: "1.0", method: "x" }),
      ],
      {
        onRequest: async (message) => {
          seen.push(message)
          return null
        },
      },
    )
    const invalid = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    }
    expect(messages).toEqual([invalid, invalid, invalid, invalid, invalid])
    expect(seen).toEqual([])
  })

  test("routes a response to onResponse and answers an unclaimed one as invalid", async () => {
    const claimed: JsonRpcResponse[] = []
    const messages = await transportOf(
      [
        line({ jsonrpc: "2.0", id: "mine", result: { ok: true } }),
        line({ jsonrpc: "2.0", id: "other", result: 1 }),
      ],
      {
        onResponse: (message) => {
          if (message.id !== "mine") return false
          claimed.push(message)
          return true
        },
      },
    )
    expect(claimed).toEqual([{ jsonrpc: "2.0", id: "mine", result: { ok: true } }])
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    ])
  })

  test("a rejected handler answers a request generically and a notification not at all", async () => {
    const messages = await transportOf(
      [
        line({ jsonrpc: "2.0", id: 1, method: "boom" }),
        line({ jsonrpc: "2.0", method: "notifications/boom" }),
      ],
      {
        onRequest: async () => {
          throw new Error("secret /etc/path in a message")
        },
      },
    )
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } },
    ])
  })

  test("a null response sends nothing", async () => {
    const messages = await transportOf(
      [line({ jsonrpc: "2.0", method: "notifications/initialized" })],
      {
        onRequest: async () => null,
      },
    )
    expect(messages).toEqual([])
  })

  test("writes to process.stdout when no output is given", async () => {
    // A notification-only session writes nothing, so the default stream is resolved but never printed to.
    await runStdioTransport({
      input: (async function* () {
        yield line({ jsonrpc: "2.0", method: "notifications/initialized" })
      })(),
      onRequest: async () => null,
    })
  })

  test("needs explicit streams on a runtime without process.stdin or process.stdout", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")
    // The defaults are resolved before the first await, so the real `process` is back before any other
    // code runs.
    const withProcess = (fake: unknown, options: StdioTransportOptions): Promise<void> => {
      Object.defineProperty(globalThis, "process", {
        value: fake,
        configurable: true,
        writable: true,
      })
      try {
        return runStdioTransport(options)
      } finally {
        if (descriptor !== undefined) Object.defineProperty(globalThis, "process", descriptor)
      }
    }
    const onRequest = async (): Promise<null> => null
    const empty = (async function* () {})()
    await expect(withProcess(undefined, { output: collector(), onRequest })).rejects.toThrow(
      "no process.stdin; pass `input`",
    )
    await expect(withProcess({ stdin: {} }, { output: collector(), onRequest })).rejects.toThrow(
      "no process.stdin; pass `input`",
    )
    await expect(withProcess({ stdout: null }, { input: empty, onRequest })).rejects.toThrow(
      "no process.stdout; pass `output`",
    )
  })

  test("rejects a non-positive or fractional message cap", async () => {
    for (const maxMessageBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(transportOf([], { maxMessageBytes })).rejects.toThrow(RangeError)
    }
  })
})

describe("runStdioTransport output", () => {
  test("an unserializable or over-cap message becomes an error with the same id", async () => {
    const messages = await transportOf(
      [
        line({ jsonrpc: "2.0", id: 1, method: "bigint" }),
        line({ jsonrpc: "2.0", id: 2, method: "huge" }),
      ],
      {
        maxMessageBytes: 200,
        onRequest: async (message) =>
          message.method === "bigint"
            ? { jsonrpc: "2.0", id: 1, result: 1n }
            : { jsonrpc: "2.0", id: 2, result: "y".repeat(500) },
      },
    )
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "MCP response is not serializable" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32603, message: "MCP response exceeded the size limit" },
      },
    ])
  })

  test("the connection sends requests and notifications of its own", async () => {
    const messages = await transportOf([line({ jsonrpc: "2.0", id: 1, method: "start" })], {
      onRequest: async (message, connection) => {
        connection.send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "info" },
        })
        connection.send({ jsonrpc: "2.0", id: "server:1", method: "roots/list" })
        return { jsonrpc: "2.0", id: message.id ?? null, result: {} }
      },
    })
    expect(messages).toEqual([
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
      { jsonrpc: "2.0", id: "server:1", method: "roots/list" },
      { jsonrpc: "2.0", id: 1, result: {} },
    ])
  })

  test("a write that throws inside a dispatch fails the transport after the input ends", async () => {
    const broken = new Error("EPIPE")
    let writes = 0
    const run = runStdioTransport({
      input: (async function* () {
        yield line({ jsonrpc: "2.0", id: 1, method: "x" })
      })(),
      output: {
        write: () => {
          writes += 1
          throw broken
        },
      },
      onRequest: async (message) => ({ jsonrpc: "2.0", id: message.id ?? null, result: 1 }),
    })
    await expect(run).rejects.toBe(broken)
    expect(writes).toBe(1)
  })
})

describe("runStdioTransport concurrency", () => {
  test("dispatches concurrently and resolves only after every request answers", async () => {
    const feed = controlledInput()
    const out = collector()
    const release = deferred()
    const started = deferred()
    let finished = false
    const run = runStdioTransport({
      input: feed.input,
      output: out,
      onRequest: async (message) => {
        if (message.method === "slow") {
          started.resolve()
          await release.promise
        }
        return { jsonrpc: "2.0", id: message.id ?? null, result: message.method }
      },
    }).then(() => {
      finished = true
    })
    feed.push(line({ jsonrpc: "2.0", id: 1, method: "slow" }))
    await started.promise
    feed.push(line({ jsonrpc: "2.0", id: 2, method: "fast" }))
    feed.end()
    await turn()
    await turn()
    expect(out.messages()).toEqual([{ jsonrpc: "2.0", id: 2, result: "fast" }])
    expect(finished).toBe(false)
    release.resolve()
    await run
    expect(out.messages()).toEqual([
      { jsonrpc: "2.0", id: 2, result: "fast" },
      { jsonrpc: "2.0", id: 1, result: "slow" },
    ])
  })
})

describe("serveStdio", () => {
  const call = (
    id: number,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): string => {
    const params: Record<string, unknown> = { name, arguments: args }
    if (meta !== undefined) params._meta = meta
    return line({ jsonrpc: "2.0", id, method: "tools/call", params })
  }

  test("serves initialize, tools/list and tools/call for a created server", async () => {
    const out = collector()
    await serveStdio(createMcpServer({ name: "orders", version: "1.2.3", tools: [echo] }), {
      input: (async function* () {
        yield line({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        })
        yield line({ jsonrpc: "2.0", method: "notifications/initialized" })
        yield line({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        yield call(3, "echo", { a: 1 })
      })(),
      output: out,
    })
    const [init, list, result] = out.messages()
    expect(pick(init, "result", "serverInfo")).toEqual({ name: "orders", version: "1.2.3" })
    expect(pick(list, "result", "tools", "length")).toBe(1)
    expect(pick(list, "result", "tools", 0, "name")).toBe("echo")
    expect(pick(result, "result", "content", 0, "text")).toBe('{"a":1}')
  })

  test("streams progress notifications before the result", async () => {
    const out = collector()
    const progress: McpTool = {
      ...echo,
      name: "progress",
      handler: async (_args, context) => {
        context.reportProgress(0.5, 1)
        return "done"
      },
    }
    await serveStdio(createMcpServer({ name: "p", version: "1", tools: [progress] }), {
      input: (async function* () {
        yield call(1, "progress", {}, { progressToken: "t" })
      })(),
      output: out,
    })
    const methods = out.messages().map((message) => pick(message, "method") ?? "result")
    expect(methods).toEqual([
      "notifications/progress",
      "notifications/progress",
      "notifications/progress",
      "result",
    ])
  })

  test("a cancellation notification aborts the running call", async () => {
    const feed = controlledInput()
    const out = collector()
    const started = deferred()
    const waiting: McpTool = {
      ...echo,
      name: "wait",
      handler: (_args, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason))
          started.resolve()
        }),
    }
    const run = serveStdio(createMcpServer({ name: "c", version: "1", tools: [waiting] }), {
      input: feed.input,
      output: out,
    })
    feed.push(call(1, "wait", {}))
    await started.promise
    feed.push(
      line({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1, reason: "stop" },
      }),
    )
    feed.end()
    await run
    const [answer] = out.messages()
    expect(pick(answer, "id")).toBe(1)
    expect(pick(answer, "result", "isError")).toBe(true)
  })

  test("hides a throwing tool's message unless exposeToolErrors is set", async () => {
    const failing: McpTool = {
      ...echo,
      name: "fail",
      handler: async () => {
        throw new Error("db at /var/secret refused")
      },
    }
    const texts = async (exposeToolErrors: boolean): Promise<unknown> => {
      const out = collector()
      await serveStdio(createMcpServer({ name: "f", version: "1", tools: [failing] }), {
        input: (async function* () {
          yield call(1, "fail", {})
        })(),
        output: out,
        exposeToolErrors,
      })
      const [answer] = out.messages()
      return pick(answer, "result", "content", 0, "text")
    }
    expect(await texts(false)).toBe("Tool execution failed")
    expect(await texts(true)).toBe("Tool execution failed: db at /var/secret refused")
  })

  test("reads process.stdin and writes process.stdout by default", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/stdio-server.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    proc.stdin.write(call(2, "echo", { from: "stdin" }))
    await proc.stdin.end()
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exitCode).toBe(0)
    const messages = stdout
      .split("\n")
      .filter((text) => text !== "")
      .map((text): unknown => JSON.parse(text))
    expect(messages.map((message) => pick(message, "id"))).toEqual([1, 2])
    expect(pick(messages[1], "result", "content")).toEqual([
      { type: "text", text: '{"from":"stdin"}' },
    ])
  })
})
