import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A real headless Chrome driven over the DevTools protocol, for tests whose failure only exists in a
 * browser: a client bundle that serves fine and then throws while it evaluates. No playwright or
 * puppeteer package - just the binary and a WebSocket.
 */

/** Chrome for Testing from a playwright cache, else a system Chrome. `NIFRA_TEST_CHROME` overrides. */
export function findChrome(): string | undefined {
  const pinned = process.env.NIFRA_TEST_CHROME
  if (pinned !== undefined && pinned !== "") return existsSync(pinned) ? pinned : undefined
  const caches = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "ms-playwright"),
  ]
  const inCache = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ]
  const candidates: string[] = []
  for (const cache of caches) {
    let builds: string[]
    try {
      builds = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name))
    } catch {
      continue
    }
    builds.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const build of builds) for (const rel of inCache) candidates.push(join(cache, build, rel))
  }
  candidates.push(
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  )
  return candidates.find((path) => existsSync(path))
}

/** The event fields read here; everything else in a message is ignored. */
interface CdpParams {
  readonly type?: string
  readonly args?: readonly { readonly value?: unknown; readonly description?: string }[]
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: CdpParams
  readonly result?: unknown
  readonly error?: { readonly message: string }
  readonly sessionId?: string
}

export interface ChromePage {
  /** Uncaught exceptions and `console.error` calls, in arrival order. */
  readonly errors: readonly string[]
  /** Navigate and wait for the load event. */
  goto(url: string): Promise<void>
  /** Evaluate an expression in the page; a promise-valued one is awaited. Returns the JSON value. */
  evaluate<T>(expression: string): Promise<T>
  /** Poll `expression` until it is truthy. Throws with the page's errors as soon as one arrives, or
   * once `timeoutMs` passes. */
  waitFor(expression: string, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export async function launchChrome(executable: string): Promise<ChromePage> {
  const profile = mkdtempSync(join(tmpdir(), "nifra-chrome-"))
  const proc = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // CI containers run without the user namespaces Chrome's sandbox needs; the page is our own.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // A headless page counts as hidden; without these, timers and frames are throttled to a crawl.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const cleanup = async (): Promise<void> => {
    proc.kill()
    // A busy machine can leave Chrome ignoring SIGTERM long enough to time a test hook out.
    const exited = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      Bun.sleep(3000).then(() => false),
    ])
    if (!exited) {
      proc.kill("SIGKILL")
      await proc.exited.catch(() => 0)
    }
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    const endpoint = await devtoolsEndpoint(proc.stderr)
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true })
    })

    const errors: string[] = []
    const pending = new Map<number, (message: CdpMessage) => void>()
    const listeners = new Set<(message: CdpMessage) => void>()
    let nextId = 0
    // Bun's test runner kills every child process when a test times out, Chrome included. A call left
    // waiting on it, and every later one, then fails at once instead of running out its own budget.
    const closed = new Promise<never>((_, reject) => {
      socket.addEventListener(
        "close",
        () => reject(new Error("headless Chrome closed its DevTools connection")),
        { once: true },
      )
    })
    closed.catch(() => undefined)
    socket.addEventListener("message", (event) => {
      const message: CdpMessage = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const settle = pending.get(message.id)
        if (typeof settle === "function") settle(message)
        pending.delete(message.id)
        return
      }
      for (const listener of listeners) listener(message)
    })
    const send = <T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<T> => {
      const id = ++nextId
      const reply = new Promise<T>((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a CDP reply is untyped JSON; each caller names the documented result shape of the method it sent
          else resolve(message.result as T)
        })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
      return Promise.race([reply, closed])
    }

    // The initial about:blank tab, not a new target: a target created later starts out backgrounded.
    const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>(
      "Target.getTargets",
    )
    const target = targetInfos.find((info) => info.type === "page")
    if (target === undefined) throw new Error("headless Chrome opened no page target")
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })

    listeners.add((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails
        errors.push(details?.exception?.description ?? details?.text ?? "exception")
      } else if (message.method === "Runtime.consoleAPICalled") {
        if (message.params?.type !== "error") return
        const args = message.params.args ?? []
        errors.push(args.map((arg) => arg.description ?? String(arg.value)).join(" "))
      }
    })
    await send("Runtime.enable", {}, sessionId)
    await send("Page.enable", {}, sessionId)

    const evaluate = async <T>(expression: string): Promise<T> => {
      const reply = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      )
      if (reply.exceptionDetails !== undefined) throw new Error(reply.exceptionDetails.text)
      return reply.result.value
    }

    return {
      errors,
      async goto(url) {
        const loaded = new Promise<void>((resolve) => {
          const onLoad = (message: CdpMessage): void => {
            if (message.sessionId !== sessionId || message.method !== "Page.loadEventFired") return
            listeners.delete(onLoad)
            resolve()
          }
          listeners.add(onLoad)
        })
        await send("Page.navigate", { url }, sessionId)
        await Promise.race([loaded, closed])
      },
      evaluate,
      async waitFor(expression, timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline && errors.length === 0) {
          if (await evaluate<boolean>(`Boolean(${expression})`)) return
          await Bun.sleep(50)
        }
        throw new Error(
          `gave up waiting for \`${expression}\`; page errors:\n${errors.join("\n") || "(none)"}`,
        )
      },
      async close() {
        socket.close()
        await cleanup()
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Chrome prints its DevTools WebSocket URL on stderr once it is listening. */
async function devtoolsEndpoint(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    const url = /DevTools listening on (ws:\/\/\S+)/.exec(text)?.[1]
    if (url !== undefined) {
      // Keep draining so a chatty Chrome never blocks on a full stderr pipe.
      void (async () => {
        for (;;) if ((await reader.read()).done) return
      })().catch(() => undefined)
      return url
    }
  }
  throw new Error(`headless Chrome never reported a DevTools endpoint:\n${text}`)
}
