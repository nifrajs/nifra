/**
 * The `nifra_ws` engine + child-process entry. The MCP server spawns this file fresh on every
 * WebSocket verification so the project's current backend code loads, then this module starts the
 * app on an ephemeral localhost port, connects with Bun's WebSocket client, and returns structured
 * evidence. It intentionally only targets the current app; this is a verification tool, not a
 * general-purpose network client.
 */

import { loadBackend } from "./mcp-run.ts"

const DEFAULT_TIMEOUT_MS = 3_000
const MAX_TIMEOUT_MS = 30_000
const MAX_MESSAGES = 50
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_PATH_LENGTH = 2_048
const ENCODER = new TextEncoder()

interface RunningServerLike {
  readonly port: number
  stop(closeActiveConnections?: boolean): void
}

interface ListenableApp {
  listen(port: number): RunningServerLike
}

interface NormalizedInput {
  readonly path: string
  readonly entry?: string
  readonly messages: readonly string[]
  readonly expectMessages: number
  readonly timeoutMs: number
}

interface CloseInfo {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

export interface WebSocketVerificationResult {
  readonly ok: boolean
  readonly opened: boolean
  readonly path: string
  readonly sent: readonly string[]
  readonly received: readonly string[]
  readonly durationMs: number
  readonly url?: string
  readonly close?: CloseInfo
  readonly error?: string
}

const errString = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function fail(
  path: string,
  sent: readonly string[],
  startedAt: number,
  error: string,
  extra: Partial<Pick<WebSocketVerificationResult, "opened" | "received" | "url" | "close">> = {},
): WebSocketVerificationResult {
  return {
    ok: false,
    opened: extra.opened ?? false,
    path,
    sent,
    received: extra.received ?? [],
    durationMs: Math.round(performance.now() - startedAt),
    error,
    ...(extra.url === undefined ? {} : { url: extra.url }),
    ...(extra.close === undefined ? {} : { close: extra.close }),
  }
}

function normalizeInput(args: unknown): NormalizedInput | { error: string; path: string } {
  if (args === null || typeof args !== "object") {
    return { error: 'expected JSON { "path": "/..." }', path: "" }
  }
  const input = args as Record<string, unknown>
  const path = input.path
  if (typeof path !== "string" || path.length === 0) {
    return { error: 'expected "path" to be a non-empty string starting with "/"', path: "" }
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { error: 'expected "path" to be an app-local path such as "/ws"', path }
  }
  if (path.length > MAX_PATH_LENGTH) {
    return { error: `"path" is too long (max ${MAX_PATH_LENGTH} characters)`, path }
  }
  if (hasControlCharacter(path)) {
    return { error: '"path" must not contain control characters', path }
  }
  if (path.includes("#")) return { error: '"path" must not include a fragment', path }

  const messagesValue = input.messages
  const messages =
    messagesValue === undefined ? [] : Array.isArray(messagesValue) ? messagesValue : undefined
  if (messages === undefined) return { error: '"messages" must be an array of strings', path }
  if (messages.length > MAX_MESSAGES) {
    return { error: `"messages" can include at most ${MAX_MESSAGES} frames`, path }
  }
  const strings: string[] = []
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "string") {
      return { error: `"messages[${index}]" must be a string`, path }
    }
    if (ENCODER.encode(message).byteLength > MAX_MESSAGE_BYTES) {
      return { error: `"messages[${index}]" is too large (max ${MAX_MESSAGE_BYTES} bytes)`, path }
    }
    strings.push(message)
  }

  const expectRaw = input.expectMessages
  const expectMessages =
    expectRaw === undefined
      ? strings.length > 0
        ? strings.length
        : 1
      : typeof expectRaw === "number" && Number.isInteger(expectRaw)
        ? expectRaw
        : undefined
  if (expectMessages === undefined || expectMessages < 0 || expectMessages > MAX_MESSAGES) {
    return { error: `"expectMessages" must be an integer from 0 to ${MAX_MESSAGES}`, path }
  }

  const timeoutRaw = input.timeoutMs
  const timeoutMs =
    timeoutRaw === undefined
      ? DEFAULT_TIMEOUT_MS
      : typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.trunc(timeoutRaw)
        : undefined
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { error: '"timeoutMs" must be a positive number', path }
  }

  const entry = input.entry
  if (entry !== undefined && typeof entry !== "string") {
    return { error: '"entry" must be a string when provided', path }
  }

  return {
    path,
    messages: strings,
    expectMessages,
    timeoutMs: Math.min(Math.max(timeoutMs, 250), MAX_TIMEOUT_MS),
    ...(entry === undefined || entry.length === 0 ? {} : { entry }),
  }
}

async function dataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text()
  return String(data)
}

function closeInfo(event: CloseEvent): CloseInfo {
  return { code: event.code, reason: event.reason, wasClean: event.wasClean }
}

function redirectConsoleToStderr(): void {
  const write = (level: string, args: unknown[]): void => {
    Bun.stderr.write(`[${level}] ${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.debug = (...args: unknown[]) => write("debug", args)
  console.info = (...args: unknown[]) => write("info", args)
  console.log = (...args: unknown[]) => write("log", args)
  console.warn = (...args: unknown[]) => write("warn", args)
  console.error = (...args: unknown[]) => write("error", args)
}

export async function runWebSocket(
  cwd: string,
  args: unknown,
): Promise<WebSocketVerificationResult> {
  const startedAt = performance.now()
  const normalized = normalizeInput(args)
  if ("error" in normalized) return fail(normalized.path, [], startedAt, normalized.error)

  const loaded = await loadBackend(cwd, normalized.entry)
  if ("error" in loaded) return fail(normalized.path, [], startedAt, loaded.error)

  const app = loaded.app as typeof loaded.app & Partial<ListenableApp>
  if (typeof app.listen !== "function") {
    return fail(
      normalized.path,
      [],
      startedAt,
      "backend app does not expose listen(); WebSocket verification requires a Bun-listenable nifra app.",
    )
  }

  let running: RunningServerLike | undefined
  let socket: WebSocket | undefined
  try {
    running = app.listen(0)
    const url = `ws://127.0.0.1:${running.port}${normalized.path}`
    socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    return await new Promise<WebSocketVerificationResult>((resolve) => {
      const received: string[] = []
      const sent: string[] = []
      let opened = false
      let close: CloseInfo | undefined
      let settled = false
      let timer: ReturnType<typeof setTimeout>

      const settle = (
        ok: boolean,
        error?: string,
        extra: Partial<Pick<WebSocketVerificationResult, "close">> = {},
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (extra.close !== undefined) close = extra.close
        resolve({
          ok,
          opened,
          path: normalized.path,
          url,
          sent,
          received,
          durationMs: Math.round(performance.now() - startedAt),
          ...(close === undefined ? {} : { close }),
          ...(error === undefined ? {} : { error }),
        })
      }

      timer = setTimeout(() => {
        settle(
          false,
          `timed out after ${normalized.timeoutMs}ms waiting for ${normalized.expectMessages} message(s); received ${received.length}`,
          close === undefined ? {} : { close },
        )
      }, normalized.timeoutMs)

      socket?.addEventListener("open", () => {
        opened = true
        try {
          for (const message of normalized.messages) {
            socket?.send(message)
            sent.push(message)
          }
        } catch (err) {
          settle(false, errString(err))
          return
        }
        if (normalized.expectMessages === 0) settle(true)
      })

      socket?.addEventListener("message", (event) => {
        void dataToString(event.data)
          .then((text) => {
            received.push(text)
            if (received.length >= normalized.expectMessages) settle(true)
          })
          .catch((err) => settle(false, errString(err)))
      })

      socket?.addEventListener("error", () => {
        settle(false, opened ? "websocket error" : "websocket failed before open")
      })

      socket?.addEventListener("close", (event) => {
        close = closeInfo(event)
        if (!settled && received.length < normalized.expectMessages) {
          settle(
            false,
            opened
              ? `websocket closed before ${normalized.expectMessages} message(s); received ${received.length}`
              : "websocket closed before open",
            { close },
          )
        }
      })
    })
  } catch (err) {
    return fail(normalized.path, [], startedAt, errString(err))
  } finally {
    try {
      if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close()
    } catch {
      // Cleanup is best effort; the structured verification result above is the important signal.
    }
    try {
      running?.stop(true)
    } catch {
      // Same as socket.close(): do not mask the verification result with teardown noise.
    }
  }
}

// Child-process entry: read `{ path, messages?, expectMessages?, timeoutMs?, entry? }` from stdin,
// verify, and print JSON to stdout. Console output from the project is redirected so agents receive
// parseable JSON even when the app logs during import or request handling.
if (import.meta.main) {
  redirectConsoleToStderr()
  const cwd = process.argv[2] ?? process.cwd()
  let output: unknown
  try {
    output = await runWebSocket(cwd, JSON.parse(await Bun.stdin.text()))
  } catch {
    output = {
      ok: false,
      opened: false,
      path: "",
      sent: [],
      received: [],
      durationMs: 0,
      error: 'invalid input: expected JSON { "path": "/..." }',
    } satisfies WebSocketVerificationResult
  }
  process.stdout.write(JSON.stringify(output, null, 2))
}
