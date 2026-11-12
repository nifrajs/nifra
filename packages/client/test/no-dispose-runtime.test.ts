import { expect, test } from "bun:test"
import vm from "node:vm"

// `Symbol.dispose` is a non-configurable property, so a runtime without it cannot be faked by deleting
// it. Instead the client is bundled and run in a context whose global `Symbol` lacks the two disposal
// symbols, which is what an older browser's global looks like to the client's code.
function symbolWithoutDisposal(): unknown {
  const fake = (description?: string): symbol => Symbol(description)
  for (const name of Object.getOwnPropertyNames(Symbol)) {
    if (name === "dispose" || name === "asyncDispose" || name === "prototype") continue
    if (name === "length" || name === "name") continue
    Object.defineProperty(fake, name, { value: Reflect.get(Symbol, name) })
  }
  return fake
}

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  readyState = 0
  closed = 0
  send(): void {}
  close(): void {
    this.closed++
  }
}

async function bundledClient(): Promise<string> {
  const entry = `${import.meta.dir}/../src/index.ts`
  const result = await Bun.build({
    entrypoints: ["entry.ts"],
    files: {
      "entry.ts": `import { client } from ${JSON.stringify(entry)}\nglobalThis.__client = client`,
    },
    format: "iife",
    target: "browser",
  })
  expect(result.success).toBe(true)
  return result.outputs[0]!.text()
}

test("the client opens and closes its handles on a runtime without Symbol.dispose", async () => {
  const sockets: FakeWebSocket[] = []
  class RecordingSocket extends FakeWebSocket {
    constructor() {
      super()
      sockets.push(this)
    }
  }
  const aborted: boolean[] = []
  const context = vm.createContext({
    WebSocket: RecordingSocket,
    fetch: (_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted.push(true)
          reject(new Error("aborted"))
        })
      }),
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    FormData,
    Blob,
    setTimeout,
    clearTimeout,
    console,
  })
  // The context's own `Symbol` intrinsic wins over a sandbox property, so the bundle runs inside a
  // function whose `Symbol` parameter is the only one its free references can reach.
  const scenario = `return (() => {
    const api = globalThis.__client("http://x")
    const subscription = api.feed.subscribe(() => {}, { onError: () => {}, reconnect: false })
    const socket = api.chat.ws()
    return {
      disposeType: typeof Symbol.dispose,
      subscriptionKeys: Object.getOwnPropertyNames(subscription),
      socketKeys: Object.getOwnPropertyNames(socket),
      close() {
        subscription.close()
        socket.close()
      },
    }
  })()`
  const run = vm.runInContext(
    `(function (Symbol) {\n${await bundledClient()}\n;${scenario}\n})`,
    context,
  )
  const result = run(symbolWithoutDisposal())
  // The runtime really lacks the symbol, so the handle's disposer is filed under the string key it
  // degrades to rather than throwing while the handle is built.
  expect(result.disposeType).toBe("undefined")
  expect(result.subscriptionKeys).toContain("undefined")
  expect(result.subscriptionKeys).toContain("close")
  expect(result.socketKeys).toContain("close")
  result.close()
  expect(sockets).toHaveLength(1)
  expect(sockets[0]?.closed).toBe(1)
  expect(aborted).toEqual([true])
})
