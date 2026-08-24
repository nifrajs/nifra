import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readBoundedText } from "./process.ts"

export interface IsolatedExtensionWorkerOptions {
  readonly modulePath: string
  readonly cwd: string
  readonly timeoutMs?: number
  readonly maxMessageBytes?: number
  readonly trustedCapabilities?: readonly string[]
}

export interface IsolatedExtensionTool {
  readonly name: string
  readonly description: string
  readonly capabilities: readonly string[]
}

export interface IsolatedExtensionSnapshot {
  readonly tools: readonly IsolatedExtensionTool[]
  readonly commands: readonly string[]
  readonly events: readonly string[]
}

interface WorkerMessage {
  readonly type?: string
  readonly id?: string
  readonly port?: number
  readonly name?: string
  readonly description?: string
  readonly capabilities?: readonly string[]
  readonly error?: string
  readonly output?: unknown
  readonly commands?: readonly string[]
  readonly tools?: readonly IsolatedExtensionTool[]
  readonly events?: readonly string[]
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: AbortController
}

/**
 * Optional process-backed extension runner. A worker crash rejects callers instead of taking down
 * the host. It is intentionally not advertised as a hostile-code sandbox: use an OS sandbox and a
 * capability decision before loading code you do not trust.
 */
export class IsolatedExtensionWorker {
  private readonly options: Required<
    Pick<IsolatedExtensionWorkerOptions, "timeoutMs" | "maxMessageBytes">
  > &
    IsolatedExtensionWorkerOptions
  private process: Bun.Subprocess | undefined
  private readonly pending = new Map<string, PendingCall>()
  private readonly tools = new Map<string, IsolatedExtensionTool>()
  private readonly commands = new Set<string>()
  private readonly events = new Set<string>()
  private buffer = ""
  private readonly token: string
  private port: number | undefined
  private started = false
  private closed = false
  private readyResolve: ((snapshot: IsolatedExtensionSnapshot) => void) | undefined
  private readyReject: ((reason?: unknown) => void) | undefined
  private readonly ready = new Promise<IsolatedExtensionSnapshot>((resolveReady, rejectReady) => {
    this.readyResolve = resolveReady
    this.readyReject = rejectReady
  })

  constructor(options: IsolatedExtensionWorkerOptions) {
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxMessageBytes: options.maxMessageBytes ?? 256 * 1024,
    }
    this.token = crypto.randomUUID().replaceAll("-", "")
    if (!isAbsolute(options.modulePath))
      throw new TypeError("isolated extension: modulePath must be absolute")
    if (!isAbsolute(options.cwd)) throw new TypeError("isolated extension: cwd must be absolute")
    if (
      !Number.isSafeInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1 ||
      this.options.timeoutMs > 24 * 60 * 60_000
    )
      throw new RangeError("isolated extension: timeoutMs is invalid")
    if (!Number.isSafeInteger(this.options.maxMessageBytes) || this.options.maxMessageBytes < 1024)
      throw new RangeError("isolated extension: maxMessageBytes must be at least 1024")
    const modulePath = realpathSync(options.modulePath)
    if (!isWithin(options.cwd, modulePath))
      throw new Error("isolated extension: module escapes cwd")
  }

  async start(): Promise<IsolatedExtensionSnapshot> {
    if (this.started) return this.ready
    this.started = true
    const workerPath = fileURLToPath(new URL("./isolated-worker.ts", import.meta.url))
    // Bun 1.4's Windows child IPC can start the worker but drop parent→child messages. The
    // loopback endpoint keeps the command channel cross-platform without exposing it remotely.
    this.process = Bun.spawn(
      [process.execPath, workerPath, realpathSync(this.options.modulePath), this.options.cwd],
      {
        cwd: this.options.cwd,
        env: {
          ...filteredEnv(),
          NIFRA_EXTENSION_TOKEN: this.token,
          NIFRA_EXTENSION_MAX_MESSAGE_BYTES: String(this.options.maxMessageBytes),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    void this.readOutput()
    void this.readErrors()
    void this.process.exited.then((status) => {
      if (!this.closed && status !== 0)
        this.fail(new Error(`isolated extension worker exited with code ${status}`))
    })
    return this.ready
  }

  get snapshot(): IsolatedExtensionSnapshot {
    return Object.freeze({
      tools: Object.freeze([...this.tools.values()]),
      commands: Object.freeze([...this.commands].sort()),
      events: Object.freeze([...this.events].sort()),
    })
  }

  async invokeTool(name: string, input: unknown): Promise<unknown> {
    await this.start()
    if (!this.tools.has(name)) throw new Error(`isolated extension: unknown tool ${name}`)
    const id = crypto.randomUUID().replaceAll("-", "")
    const abort = new AbortController()
    const result = new Promise<unknown>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        abort.abort()
        rejectResult(new Error(`isolated extension: tool ${name} timed out`))
      }, this.options.timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer, abort })
    })
    void this.sendInvoke(id, name, input, abort.signal).catch((error: unknown) => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    })
    return result
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.fail(new Error("isolated extension worker closed"))
    this.process?.kill()
    await this.process?.exited
  }

  private async sendInvoke(
    id: string,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const port = this.port
    if (!isValidPort(port))
      throw new Error("isolated extension: worker control endpoint unavailable")
    const text = JSON.stringify({ type: "invoke", id, name, input })
    if (Buffer.byteLength(text, "utf8") > this.options.maxMessageBytes)
      throw new RangeError("isolated extension: message is too large")
    const response = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: text,
      signal,
    })
    const body = await readBoundedText(response.body, this.options.maxMessageBytes)
    if (body.truncated) throw new Error("isolated extension: worker response exceeded limit")
    if (!response.ok)
      throw new Error(`isolated extension: worker request failed (${response.status})`)
    let message: WorkerMessage
    try {
      message = JSON.parse(body.text) as WorkerMessage
    } catch {
      throw new Error("isolated extension: worker returned invalid JSON")
    }
    if (message.type !== "result" || message.id !== id)
      throw new Error("isolated extension: worker returned an invalid result")
    const pending = this.pending.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (message.error !== undefined) pending.reject(new Error(message.error))
    else pending.resolve(message.output)
  }

  private async readOutput(): Promise<void> {
    const stdout = this.process?.stdout
    if (stdout === undefined || stdout === null || typeof stdout === "number") return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) this.consume(decoder.decode(value, { stream: true }))
      }
      this.consume(decoder.decode())
    } catch (error) {
      this.fail(error)
    } finally {
      reader.releaseLock()
    }
  }

  private async readErrors(): Promise<void> {
    const stderr = this.process?.stderr
    if (stderr === undefined || stderr === null || typeof stderr === "number") return
    await readBoundedText(stderr, this.options.maxMessageBytes).catch(() => {})
  }

  private consume(text: string): void {
    this.buffer += text
    if (Buffer.byteLength(this.buffer, "utf8") > this.options.maxMessageBytes * 2) {
      this.fail(new Error("isolated extension: worker output exceeded limit"))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      let message: WorkerMessage
      try {
        message = JSON.parse(line) as WorkerMessage
      } catch {
        this.fail(new Error("isolated extension: worker emitted invalid JSON"))
        return
      }
      this.handle(message)
    }
  }

  private handle(message: WorkerMessage): void {
    if (message.type === "ready") {
      const port = message.port
      if (!isValidPort(port)) {
        this.fail(new Error("isolated extension: worker control endpoint is invalid"))
        this.process?.kill()
        return
      }
      this.port = port
      this.readyResolve?.(this.snapshot)
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }
    if (message.type === "registration") {
      const denied = (message.capabilities ?? []).find(
        (capability) => !(this.options.trustedCapabilities ?? []).includes(capability),
      )
      if (denied !== undefined) {
        this.fail(new Error(`isolated extension: untrusted capability ${denied}`))
        this.process?.kill()
        return
      }
      if (typeof message.name === "string")
        this.tools.set(
          message.name,
          Object.freeze({
            name: message.name,
            description: message.description ?? "",
            capabilities: Object.freeze([...(message.capabilities ?? [])]),
          }),
        )
      return
    }
    if (message.type === "fatal") {
      this.fail(new Error(message.error ?? "isolated extension worker failed"))
      return
    }
    if (message.type === "command" && typeof message.name === "string")
      this.commands.add(message.name)
    if (message.type === "event" && typeof message.name === "string") this.events.add(message.name)
    if (message.type !== "result" || typeof message.id !== "string") return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error !== undefined) pending.reject(new Error(message.error))
    else pending.resolve(message.output)
  }

  private fail(error: unknown): void {
    this.readyReject?.(error)
    this.readyReject = undefined
    this.readyResolve = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.abort.abort()
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === "" || (!path.startsWith("..") && !path.includes("/.."))
}

function isValidPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
}

function filteredEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM"]) {
    const value = process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
