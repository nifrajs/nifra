import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { type ReflectedRoute, reflectRoutes } from "@nifrajs/core/reflection"

export interface ContractDigest {
  readonly request: string
  readonly response: string
}

export interface ContractsLock {
  readonly version: 1
  readonly routes: Readonly<Record<string, ContractDigest>>
}

export const DEFAULT_CONTRACTS_LOCK = "contracts.lock.json"
const DIGEST = /^[a-f0-9]{64}$/

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function canonical(value: unknown, key?: string): unknown {
  if (["description", "title", "default", "example", "examples"].includes(key ?? ""))
    return undefined
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  const record = recordOf(value)
  if (record === undefined) return value
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(record).sort()) {
    const item = canonical(record[name], name)
    if (item !== undefined) out[name] = item
  }
  return out
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("")
}

function schemaValue(route: ReflectedRoute, side: "request" | "response"): unknown {
  const schema = route.schema
  if (schema === undefined) return {}
  if (side === "request") {
    return {
      body: schema.body?.jsonSchema ?? schema.body?.fields ?? null,
      query: schema.query?.jsonSchema ?? schema.query?.fields ?? null,
      params: schema.params?.jsonSchema ?? schema.params?.fields ?? null,
    }
  }
  return {
    response: schema.response?.jsonSchema ?? schema.response?.fields ?? null,
    sse: schema.sse?.jsonSchema ?? schema.sse?.fields ?? null,
    errors: Object.fromEntries(
      Object.entries(schema.errors ?? {}).map(([status, value]) => [
        status,
        value.jsonSchema ?? value.fields ?? null,
      ]),
    ),
  }
}

export async function digestRoute(route: ReflectedRoute): Promise<ContractDigest> {
  const request = JSON.stringify(canonical(schemaValue(route, "request")))
  const response = JSON.stringify(canonical(schemaValue(route, "response")))
  return { request: await sha256(request), response: await sha256(response) }
}

export async function buildContractsLock(source: unknown): Promise<ContractsLock> {
  const routes = Object.fromEntries(
    await Promise.all(
      reflectRoutes(source).map(
        async (route) => [`${route.method} ${route.path}`, await digestRoute(route)] as const,
      ),
    ),
  )
  return {
    version: 1,
    routes: Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))),
  }
}

async function loadBackend(cwd: string): Promise<unknown> {
  const backendPath = resolve(cwd, "backend.ts")
  if (!existsSync(backendPath)) throw new Error(`[nifra] no backend.ts in ${cwd}`)
  const loadedValue: unknown = await import(backendPath)
  const loaded = recordOf(loadedValue)
  if (loaded?.backend === undefined)
    throw new Error(`[nifra] ${backendPath} does not export backend`)
  return loaded.backend
}

export async function snapshotContracts(
  cwd: string,
  out = DEFAULT_CONTRACTS_LOCK,
): Promise<ContractsLock> {
  const lock = await buildContractsLock(await loadBackend(cwd))
  await Bun.write(resolve(cwd, out), `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export function parseContractsLock(value: unknown): ContractsLock {
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("contracts lock must be an object")
  const routesValue = record.routes
  const routesRecord = recordOf(routesValue)
  if (record.version !== 1 || routesRecord === undefined)
    throw new TypeError("contracts lock must have version 1 and routes")
  const routes: Record<string, ContractDigest> = {}
  for (const [key, raw] of Object.entries(routesRecord)) {
    const item = recordOf(raw)
    const request = item?.request
    const response = item?.response
    if (
      request === undefined ||
      typeof request !== "string" ||
      response === undefined ||
      typeof response !== "string" ||
      !DIGEST.test(request) ||
      !DIGEST.test(response)
    )
      throw new TypeError(`invalid contract ${key}`)
    routes[key] = { request, response }
  }
  return { version: 1, routes }
}

export async function checkContractsLock(
  cwd: string,
  file = DEFAULT_CONTRACTS_LOCK,
): Promise<{ present: boolean; diagnostics: Array<{ route?: string; message: string }> }> {
  const path = resolve(cwd, file)
  if (!existsSync(path)) return { present: false, diagnostics: [] }
  const parsed = parseContractsLock(JSON.parse(await Bun.file(path).text()))
  const current = await buildContractsLock(await loadBackend(cwd))
  const diagnostics: Array<{ route?: string; message: string }> = []
  const keys = new Set([...Object.keys(parsed.routes), ...Object.keys(current.routes)])
  for (const key of [...keys].sort()) {
    const before = parsed.routes[key]
    const after = current.routes[key]
    if (
      before === undefined ||
      after === undefined ||
      before.request !== after.request ||
      before.response !== after.response
    ) {
      diagnostics.push({
        route: key,
        message: `contract changed for ${key}; if intentional run \`nifra contracts snapshot\` and include the lock update in the same change.`,
      })
    }
  }
  return { present: true, diagnostics }
}
