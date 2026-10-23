import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IsolatedExtensionWorker, type IsolatedExtensionWorkerOptions } from "../src/isolated.ts"

let root = ""

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "nifra-isolated-")))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function moduleFile(name: string, source: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, source)
  return path
}

async function withWorker(
  options: Omit<IsolatedExtensionWorkerOptions, "cwd">,
  run: (worker: IsolatedExtensionWorker) => Promise<void>,
): Promise<void> {
  const worker = new IsolatedExtensionWorker({ cwd: root, ...options })
  try {
    await run(worker)
  } finally {
    await worker.close()
  }
}

const tools = `
export default ({ registerTool, registerCommand, on }) => {
  registerCommand("greet")
  on("turn.started")
  registerTool({ name: "echo", description: "Echo", execute: (input) => input })
  registerTool({ name: "hang", description: "Never answers", execute: () => new Promise(() => {}) })
  registerTool({ name: "env", description: "Read env", execute: (name) => process.env[name] ?? null })
}
`

describe("isolated extension worker options", () => {
  test("refuse a relative module, a small message cap and a module outside cwd", async () => {
    const path = await moduleFile("options.ts", tools)
    expect(() => new IsolatedExtensionWorker({ modulePath: "options.ts", cwd: root })).toThrow(
      "modulePath must be absolute",
    )
    expect(
      () => new IsolatedExtensionWorker({ modulePath: path, cwd: root, maxMessageBytes: 512 }),
    ).toThrow("maxMessageBytes must be at least 1024")
    const nested = join(root, "nested")
    await mkdir(nested, { recursive: true })
    expect(() => new IsolatedExtensionWorker({ modulePath: path, cwd: nested })).toThrow(
      "module escapes cwd",
    )
  })
})

describe("isolated extension worker registration", () => {
  test("records commands and events next to tools", async () => {
    await withWorker({ modulePath: await moduleFile("register.ts", tools) }, async (worker) => {
      const snapshot = await worker.start()
      expect(snapshot.tools.map((tool) => tool.name)).toEqual(["echo", "hang", "env"])
      expect(snapshot.commands).toEqual(["greet"])
      expect(snapshot.events).toEqual(["turn.started"])
    })
  })

  test("a tool asking for an untrusted capability fails the start", async () => {
    const modulePath = await moduleFile(
      "untrusted.ts",
      `export default ({ registerTool }) => registerTool({ name: "fetch", description: "", capabilities: ["network"], execute: () => 1 })\n`,
    )
    await withWorker({ modulePath }, async (worker) => {
      await expect(worker.start()).rejects.toThrow("untrusted capability network")
    })
    await withWorker({ modulePath, trustedCapabilities: ["network"] }, async (worker) => {
      expect((await worker.start()).tools[0]?.capabilities).toEqual(["network"])
    })
  })

  test("a module that throws while loading fails the start with its message", async () => {
    const modulePath = await moduleFile(
      "throws.ts",
      `export default () => { throw new Error("cannot load the extension") }\n`,
    )
    await withWorker({ modulePath }, async (worker) => {
      await expect(worker.start()).rejects.toThrow("cannot load the extension")
    })
  })
})

describe("isolated extension worker output", () => {
  test("a line that is not JSON fails the start", async () => {
    const modulePath = await moduleFile(
      "garbage.ts",
      `export default () => { process.stdout.write("not json\\n"); return new Promise(() => {}) }\n`,
    )
    await withWorker({ modulePath }, async (worker) => {
      await expect(worker.start()).rejects.toThrow("worker emitted invalid JSON")
    })
  })

  test("a ready message without a valid port fails the start", async () => {
    const modulePath = await moduleFile(
      "bad-port.ts",
      `export default () => { process.stdout.write(JSON.stringify({ type: "ready", port: 0 }) + "\\n"); return new Promise(() => {}) }\n`,
    )
    await withWorker({ modulePath }, async (worker) => {
      await expect(worker.start()).rejects.toThrow("worker control endpoint is invalid")
    })
  })

  test("an unterminated line past twice the message cap fails the start", async () => {
    const modulePath = await moduleFile(
      "flood.ts",
      `export default () => { process.stdout.write("x".repeat(4096)); return new Promise(() => {}) }\n`,
    )
    await withWorker({ modulePath, maxMessageBytes: 1024 }, async (worker) => {
      await expect(worker.start()).rejects.toThrow("worker output exceeded limit")
    })
  })

  test("a result line for no pending call is ignored", async () => {
    const modulePath = await moduleFile(
      "stray.ts",
      `export default ({ registerTool }) => {
        process.stdout.write(JSON.stringify({ type: "result", id: "nobody" }) + "\\n")
        registerTool({ name: "echo", description: "Echo", execute: (input) => input })
      }\n`,
    )
    await withWorker({ modulePath }, async (worker) => {
      await worker.start()
      await expect(worker.invokeTool("echo", "still works")).resolves.toBe("still works")
    })
  })
})

describe("isolated extension worker calls", () => {
  test("an input over the message cap is refused before it is sent", async () => {
    await withWorker(
      { modulePath: await moduleFile("cap.ts", tools), maxMessageBytes: 1024 },
      async (worker) => {
        await worker.start()
        await expect(worker.invokeTool("echo", "x".repeat(2048))).rejects.toThrow(
          "message is too large",
        )
      },
    )
  })

  test("a call that outlives timeoutMs is rejected", async () => {
    await withWorker(
      { modulePath: await moduleFile("timeout.ts", tools), timeoutMs: 50 },
      async (worker) => {
        await worker.start()
        await expect(worker.invokeTool("hang", {})).rejects.toThrow("tool hang timed out")
      },
    )
  })

  test("closing the worker rejects the calls still waiting", async () => {
    const worker = new IsolatedExtensionWorker({
      modulePath: await moduleFile("close.ts", tools),
      cwd: root,
    })
    await worker.start()
    const outcome = worker.invokeTool("hang", {}).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    // invokeTool registers the call once its own `await start()` settles: a macrotask is past that.
    await new Promise((resolve) => setImmediate(resolve))
    await worker.close()
    expect(await outcome).toBe("isolated extension worker closed")
  })
})

describe("isolated extension worker environment", () => {
  test("on Windows the worker keeps the Windows names", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    process.env.SystemRoot = "C:\\Windows"
    try {
      await withWorker({ modulePath: await moduleFile("env.ts", tools) }, async (worker) => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true })
        // The environment is built when the worker spawns, inside start's synchronous part.
        const starting = worker.start()
        if (platform !== undefined) Object.defineProperty(process, "platform", platform)
        await starting
        await expect(worker.invokeTool("env", "SystemRoot")).resolves.toBe("C:\\Windows")
      })
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform)
      delete process.env.SystemRoot
    }
  })
})
