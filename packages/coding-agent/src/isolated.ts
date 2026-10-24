import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { childProcessEnv } from "@nifrajs/agent-protocol"
import { readBoundedText } from "./process.ts"

export interface IsolatedExtensionWorkerOptions {
  readonly modulePath: string
  readonly cwd: string
  /** How long one tool call may run. Default 30 s. */
  readonly timeoutMs?: number
  /** How long `start()` waits for the module to load and register. Default 30 s. */
  readonly startTimeoutMs?: number
  readonly maxMessageBytes?: number
  /** Include bounded worker exception stacks for trusted local debugging. */
  readonly exposeErrorStacks?: boolean
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
  readonly stack?: string
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
    Pick<IsolatedExtensionWorkerOptions, "timeoutMs" | "startTimeoutMs" | "maxMessageBytes">
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
      startTimeoutMs: options.startTimeoutMs ?? 30_000,
      maxMessageBytes: options.maxMessageBytes ?? 256 * 1024,
    }
    this.token = crypto.randomUUID().replaceAll("-", "")
    if (!isAbsolute(options.modulePath))
      throw new TypeError("isolated extension: modulePath must be absolute")
    if (!isAbsolute(options.cwd)) throw new TypeError("isolated extension: cwd must be absolute")
    for (const name of ["timeoutMs", "startTimeoutMs"] as const) {
      const value = this.options[name]
      if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000)
        throw new RangeError(`isolated extension: ${name} is invalid`)
    }
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
          ...childProcessEnv({ env: process.env, platform: process.platform }),
          NIFRA_EXTENSION_TOKEN: this.token,
          NIFRA_EXTENSION_MAX_MESSAGE_BYTES: String(this.options.maxMessageBytes),
          NIFRA_EXTENSION_EXPOSE_ERROR_STACKS: this.options.exposeErrorStacks === true ? "1" : "0",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = this.readOutput()
    void this.readErrors()
    // Any exit we did not ask for is a failure, a clean one included: nothing would answer. The
    // worker writes why it stopped just before exiting, and the exit can be seen first, so an exit
    // fails the start only once that output is read.
    void Promise.all([this.process.exited, output]).then(([status]) => {
      if (!this.closed) this.fail(new Error(`isolated extension worker exited with code ${status}`))
    })
    const deadline = setTimeout(() => {
      this.fail(
        new Error(
          `isolated extension: worker was not ready within ${this.options.startTimeoutMs}ms`,
        ),
      )
      this.process?.kill()
    }, this.options.startTimeoutMs)
    const settled = () => clearTimeout(deadline)
    void this.ready.then(settled, settled)
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
    if (message.error !== undefined) pending.reject(workerError(message))
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
      this.fail(workerError(message))
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
    if (message.error !== undefined) pending.reject(workerError(message))
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
  // On Windows a path on another drive has no relative form, so `relative` returns it absolute.
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isValidPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
}

function workerError(message: WorkerMessage): Error {
  const error = new Error(message.error ?? "isolated extension worker failed")
  if (message.stack !== undefined) error.stack = message.stack
  return error
}
