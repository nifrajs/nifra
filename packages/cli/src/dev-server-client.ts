/**
 * Finds the running `nifra dev` server a tool should read, and reads its agent feed.
 *
 * A dev server writes `.nifra/dev-server.json` (owner-only) with its port and a per-run token. A
 * record alone proves nothing - the process may have died and the port been reused - so a server
 * counts as live only after it answers the identity endpoint with the record's own pid and root.
 */

import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  DEV_FEED_HEADER,
  DEV_FEED_PATHS,
  DEV_SERVER_LOG_FILE,
  DEV_SERVER_RECORD_FILE,
  DEV_TOKEN_HEADER,
  type DevPipeline,
  type DevServerIdentity,
  type DevServerRecord,
  isProcessAlive,
  readDevServerRecord,
} from "@nifrajs/web/dev-feed"
import { LOCAL_TOOL_FETCH_TIMEOUT_MS, readBoundedResponse, validateLocalPort } from "./mcp-io.ts"

export interface LiveDevServer {
  readonly root: string
  readonly port: number
  readonly origin: string
  readonly pipeline: DevPipeline
  readonly pid: number
  readonly startedAt: string
  readonly token: string
  readonly identity: DevServerIdentity
}

/** A dev server whose record survived it: it crashed or was killed before it could clean up. */
export interface DeadDevServer {
  readonly root: string
  readonly port: number
  readonly pid: number
  readonly startedAt: string
}

export type DevServerLookup =
  | { readonly status: "live"; readonly server: LiveDevServer }
  /** An explicit port no record under the project names: reachable only through token-free paths. */
  | { readonly status: "unverified"; readonly port: number; readonly origin: string }
  | {
      readonly status: "ambiguous"
      readonly servers: readonly Pick<LiveDevServer, "root" | "port" | "pipeline">[]
    }
  | {
      readonly status: "down"
      /** Project roots holding a persisted feed from an earlier run, nearest first. */
      readonly persisted: readonly string[]
      readonly dead: readonly DeadDevServer[]
      /** Servers whose record and process exist but which did not answer as themselves. */
      readonly unreachable: readonly {
        readonly root: string
        readonly port: number
        readonly reason: string
      }[]
    }
  | { readonly status: "invalid-port" }

export interface FindDevServerOptions {
  readonly port?: number | undefined
}

// Where a workspace keeps its apps. One level only: the scan runs on every tool call.
const SCAN_PARENTS = [".", "apps", "packages", "examples"] as const
const MAX_SCANNED_ROOTS = 512

function candidateRoots(cwd: string): string[] {
  const roots = [cwd]
  for (const parent of SCAN_PARENTS) {
    const base = join(cwd, parent)
    let names: string[]
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith(".") && name !== "node_modules")
        .sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (roots.length >= MAX_SCANNED_ROOTS) return roots
      const root = join(base, name)
      if (!roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

const originOf = (port: number): string => `http://127.0.0.1:${port}`

function isIdentity(value: unknown): value is DevServerIdentity {
  if (typeof value !== "object" || value === null) return false
  return (
    "pid" in value &&
    typeof value.pid === "number" &&
    "root" in value &&
    typeof value.root === "string" &&
    "port" in value &&
    typeof value.port === "number" &&
    "cursor" in value &&
    typeof value.cursor === "number"
  )
}

type Verified =
  | { readonly ok: true; readonly server: LiveDevServer }
  | { readonly ok: false; readonly reason: string }

async function verify(record: DevServerRecord, signal?: AbortSignal): Promise<Verified> {
  const origin = originOf(record.port)
  let body: unknown
  try {
    const response = await fetch(`${origin}${DEV_FEED_PATHS.identity}`, {
      headers: { [DEV_TOKEN_HEADER]: record.token },
      signal: anySignal(signal),
    })
    if (response.headers.get(DEV_FEED_HEADER) !== "true")
      return { ok: false, reason: `port ${record.port} is not a nifra dev server` }
    if (!response.ok) return { ok: false, reason: `identity check returned ${response.status}` }
    body = JSON.parse(await readBoundedResponse(response))
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  // A recycled port can host a different nifra server; its pid and root give it away.
  if (!isIdentity(body) || body.pid !== record.pid || resolve(body.root) !== resolve(record.root))
    return { ok: false, reason: `port ${record.port} now belongs to another server` }
  return {
    ok: true,
    server: {
      root: record.root,
      port: record.port,
      origin,
      pipeline: record.pipeline,
      pid: record.pid,
      startedAt: record.startedAt,
      token: record.token,
      identity: body,
    },
  }
}

function anySignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(LOCAL_TOOL_FETCH_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * The dev server for the project at `cwd`: its own record first, else the one live server among the
 * workspace's apps. An explicit `port` picks among them, and still works when no record names it.
 */
export async function findDevServer(
  cwd: string,
  options: FindDevServerOptions = {},
  signal?: AbortSignal,
): Promise<DevServerLookup> {
  let port: number | undefined
  if (options.port !== undefined) {
    port = validateLocalPort(options.port)
    if (port === undefined) return { status: "invalid-port" }
  }
  // The project's own live server wins outright, whatever else the workspace runs.
  const own = readDevServerRecord(cwd)
  if (own !== undefined && (port === undefined || own.port === port) && isProcessAlive(own.pid)) {
    const result = await verify(own, signal)
    if (result.ok) return { status: "live", server: result.server }
  }
  const roots = candidateRoots(cwd)
  const records: DevServerRecord[] = []
  const dead: DeadDevServer[] = []
  for (const root of roots) {
    if (!existsSync(join(root, DEV_SERVER_RECORD_FILE))) continue
    const record = readDevServerRecord(root)
    if (record === undefined) continue
    if (port !== undefined && record.port !== port) continue
    if (isProcessAlive(record.pid)) records.push(record)
    else dead.push({ root, port: record.port, pid: record.pid, startedAt: record.startedAt })
  }
  const checked = await Promise.all(records.map((record) => verify(record, signal)))
  const live: LiveDevServer[] = []
  const unreachable: { root: string; port: number; reason: string }[] = []
  checked.forEach((result, index) => {
    const record = records[index]
    if (record === undefined) return
    if (result.ok) live.push(result.server)
    else unreachable.push({ root: record.root, port: record.port, reason: result.reason })
  })
  const [first] = live
  if (first !== undefined && live.length === 1) return { status: "live", server: first }
  if (live.length > 1) {
    return {
      status: "ambiguous",
      servers: live.map(({ root, port: livePort, pipeline }) => ({
        root,
        port: livePort,
        pipeline,
      })),
    }
  }
  if (port !== undefined && unreachable.length === 0)
    return { status: "unverified", port, origin: originOf(port) }
  const persisted = roots.filter((root) => existsSync(join(root, DEV_SERVER_LOG_FILE)))
  return { status: "down", persisted, dead, unreachable }
}

export type FeedQuery = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>

/** GET one feed endpoint as the authenticated agent. Throws when the server does not answer with JSON. */
export async function readDevFeed(
  server: LiveDevServer,
  path: string,
  query: FeedQuery = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, server.origin)
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue
    url.searchParams.set(name, Array.isArray(value) ? value.join(",") : String(value))
  }
  const response = await fetch(url, {
    headers: { [DEV_TOKEN_HEADER]: server.token },
    signal: anySignal(signal),
  })
  if (response.headers.get(DEV_FEED_HEADER) !== "true")
    throw new Error(`${server.origin} did not answer as a nifra dev server`)
  const text = await readBoundedResponse(response)
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

/** One line telling a caller how to get past a lookup that did not yield a single live server. */
export function describeLookup(
  lookup: Exclude<DevServerLookup, { status: "live" }>,
  cwd: string,
): string {
  switch (lookup.status) {
    case "invalid-port":
      return "port must be an integer from 1 to 65535."
    case "unverified":
      return `No ${DEV_SERVER_RECORD_FILE} under ${cwd} names port ${lookup.port}. Pass \`dir\` (the project that server runs) so its token can be read.`
    case "ambiguous":
      return `${lookup.servers.length} dev servers are running: ${lookup.servers.map((s) => `${s.root} (:${s.port})`).join(", ")}. Pass \`dir\` or \`port\` to pick one.`
    case "down": {
      const parts: string[] = []
      for (const server of lookup.dead)
        parts.push(
          `the dev server for ${server.root} (:${server.port}, pid ${server.pid}) is gone without cleaning up - it crashed or was killed`,
        )
      for (const server of lookup.unreachable)
        parts.push(
          `the dev server for ${server.root} (:${server.port}) did not answer: ${server.reason}`,
        )
      if (parts.length === 0)
        parts.push(`no nifra dev server is running for ${cwd}; start one with \`nifra dev\``)
      return `${parts.join("; ")}.`
    }
  }
}
