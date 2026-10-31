/**
 * `nifra mcp` after the project installed another CLI than the one serving the session. This process
 * keeps the code it started with, so it would go on listing tools the new release removed and running
 * them. It starts the project's CLI as a child instead, replays the handshake to it, and relays the
 * rest of the conversation: the client's messages go in, and what the child sends comes back out. The
 * start-of-session hand-off (`./mcp-delegate.ts`) is the same move made before stdin is read.
 */

import type { StdioMessage } from "@nifrajs/mcp/stdio"
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  rpcError,
} from "./mcp-protocol.ts"

type JsonRpcId = JsonRpcResponse["id"]

const HANDSHAKE_ID = "nifra-relay-handshake"
const HANDSHAKE_MS = 30_000
const CLOSE_MS = 5_000

const spawnChild = (
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => Bun.spawn([...command], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" })

export interface McpRelay {
  /** Whether the child still runs. Once it ends the session is served locally again. */
  readonly alive: boolean
  /** Send a client message on. Resolves to the child's response, or `null` for a notification. */
  request(message: JsonRpcRequest): Promise<JsonRpcResponse | null>
  /** Pass the client's answer to a request the child made on. */
  answer(message: JsonRpcResponse): void
  /** End the child's input and wait for it. */
  close(): Promise<void>
}

/**
 * Start `command` as the session's server. Resolves to `undefined`, with the child gone, when it does
 * not start or does not answer the replayed `initialize`; its response is not forwarded, since the
 * client has had its own.
 */
export async function startRelay(options: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly initialize: JsonRpcRequest
  /** Whether the client sent `notifications/initialized`. */
  readonly initialized: boolean
  /** Writes one message to the client. */
  readonly send: (message: StdioMessage) => void
  /** Written to stderr once the child answers. */
  readonly announce: string
}): Promise<McpRelay | undefined> {
  let child: ReturnType<typeof spawnChild>
  try {
    child = spawnChild(options.command, options.cwd, options.env)
  } catch {
    return undefined
  }
  let alive = true
  const pending = new Map<JsonRpcId, (response: JsonRpcResponse | null) => void>()
  const settle = (id: JsonRpcId, response: JsonRpcResponse | null): void => {
    const resolve = pending.get(id)
    pending.delete(id)
    resolve?.(response)
  }
  const write = (message: object): boolean => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      child.stdin.flush()
      return true
    } catch {
      return false
    }
  }
  const route = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (isJsonRpcResponse(parsed)) {
      if (pending.has(parsed.id)) settle(parsed.id, parsed)
      else options.send(parsed)
    } else if (isJsonRpcRequest(parsed)) options.send(parsed)
  }
  const pumped = (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at).trim()
        buffered = buffered.slice(at + 1)
        if (line !== "") route(line)
      }
    }
  })().catch(() => {})
  void child.exited.then(async () => {
    await pumped
    alive = false
    for (const id of [...pending.keys()]) {
      settle(id, rpcError(id, -32603, "the project's nifra CLI ended while it was answering"))
    }
  })

  const handshake = new Promise<JsonRpcResponse | null>((resolve) => {
    pending.set(HANDSHAKE_ID, resolve)
  })
  const timer = setTimeout(() => settle(HANDSHAKE_ID, null), HANDSHAKE_MS)
  write({ ...options.initialize, id: HANDSHAKE_ID })
  const answered = await handshake
  clearTimeout(timer)
  if (answered === null || "error" in answered) {
    child.kill()
    return undefined
  }
  if (options.initialized) write({ jsonrpc: "2.0", method: "notifications/initialized" })
  process.stderr.write(`${options.announce}\n`)

  return {
    get alive() {
      return alive
    },
    request(message) {
      return new Promise((resolve) => {
        if (message.id !== undefined) pending.set(message.id, resolve)
        if (!write(message)) {
          if (message.id === undefined) resolve(null)
          else settle(message.id, rpcError(message.id, -32603, "the project's nifra CLI is gone"))
          return
        }
        if (message.id === undefined) resolve(null)
      })
    },
    answer(message) {
      write(message)
    },
    async close() {
      try {
        child.stdin.end()
      } catch {
        // Already closed: the child is on its way out.
      }
      const killer = setTimeout(() => child.kill(), CLOSE_MS)
      await child.exited
      clearTimeout(killer)
    },
  }
}
