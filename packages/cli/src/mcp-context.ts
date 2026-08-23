/**
 * Project context and trust-local utilities for the MCP server.
 *
 * Resources, prompts, path scoping, and monorepo namespacing are independent of the JSON-RPC loop and
 * of backend reflection. App loading is injected through the shared cached loader seam.
 */

import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import type { LoadedApp } from "./load.ts"
import { createCachedAppLoader } from "./mcp-exec.ts"
import type { McpPrompt, McpResource, McpServerFeatures, McpTool } from "./mcp-protocol.ts"

function openApiFormat(args: Record<string, unknown>): "json" | "yaml" {
  const format = args.format
  return format === "yaml" ? "yaml" : "json"
}

export async function openApiHandler(
  args: Record<string, unknown>,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp>,
): Promise<string> {
  const { renderOpenApiWithTypes } = await import("./openapi-tool.ts")
  const pathPrefix = typeof args.path === "string" ? args.path : undefined
  return renderOpenApiWithTypes(await loadAppCached(), openApiFormat(args), pathPrefix)
}

async function readProjectFile(
  cwd: string,
  relativeFile: string,
  maxChars: number,
): Promise<string> {
  const target = resolve(cwd, relativeFile)
  const root = resolve(cwd)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to read outside project root: ${relativeFile}`)
  }
  try {
    const text = await readFile(target, "utf8")
    return text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}\n…(trimmed; read ${relativeFile} directly for the rest)`
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return `No ${relativeFile} found in ${basename(cwd)}.`
    }
    throw err
  }
}

function promptText(
  text: string,
): readonly [
  { readonly role: "user"; readonly content: { readonly type: "text"; readonly text: string } },
] {
  return [{ role: "user", content: { type: "text", text } }]
}

export function projectResources(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpResource[] {
  return [
    {
      uri: "nifra://routes",
      name: "API routes",
      description:
        "Structured API routes with typed-client calls and compact request/response shapes.",
      mimeType: "application/json",
      read: async () => {
        const { routesToJson } = await import("./introspect.ts")
        return { text: JSON.stringify(routesToJson(await loadAppCached()), null, 2) }
      },
    },
    {
      uri: "nifra://openapi",
      name: "OpenAPI 3.1",
      description: "OpenAPI document generated from backend.ts using @nifrajs/schema.",
      mimeType: "application/json",
      read: async () => ({ text: await openApiHandler({ format: "json" }, loadAppCached) }),
    },
    {
      uri: "nifra://package-json",
      name: "package.json",
      description: "Project package metadata and scripts.",
      mimeType: "application/json",
      read: async () => ({ text: await readProjectFile(cwd, "package.json", 40_000) }),
    },
    {
      uri: "nifra://agents-md",
      name: "AGENTS.md",
      description: "Repository-specific agent instructions if the project has them.",
      mimeType: "text/markdown",
      read: async () => ({ text: await readProjectFile(cwd, "AGENTS.md", 40_000) }),
    },
  ]
}

export function projectPrompts(): McpPrompt[] {
  return [
    {
      name: "nifra_new_route",
      description:
        "Implement a new file route with the right routes/ filename, examples, and checks.",
      arguments: [
        { name: "path", description: 'URL path, e.g. "/users/:id".', required: true },
        { name: "goal", description: "What the page should do.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            `Create a nifra page route for ${JSON.stringify(args.path ?? "/new-route")}.`,
            args.goal ? `Goal: ${String(args.goal)}` : undefined,
            'Use `nifra_context` with `{ kind: "pages" }`, then `nifra_scaffold` for the exact file path.',
            "If the stub is not writable for this framework, call `nifra_example` for a verified page/loader example before editing.",
            "Verify with `nifra_render` for the route and finish with `nifra_check`.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
    {
      name: "nifra_add_endpoint",
      description:
        "Add or update a backend endpoint with schemas, typed-client usage, and verification.",
      arguments: [
        { name: "method", description: "HTTP method.", required: true },
        { name: "path", description: 'API path, e.g. "/users/:id".', required: true },
        { name: "goal", description: "What the endpoint should do.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            `Add a nifra backend endpoint: ${String(args.method ?? "GET").toUpperCase()} ${String(args.path ?? "/api")}.`,
            args.goal ? `Goal: ${String(args.goal)}` : undefined,
            "Read `nifra://routes` or call `nifra_routes` first so the new route fits the existing API shape.",
            "Use route schemas for untrusted body/query input and declare `response` when the frontend consumes the shape.",
            "Verify behavior with `nifra_run`, then run `nifra_check` and `nifra_test` for the touched area.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
    {
      name: "nifra_debug_drift",
      description:
        "Debug frontend/backend contract drift using the typed client and checker output.",
      arguments: [
        { name: "symptom", description: "The error or behavior to investigate.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            "Debug nifra contract drift.",
            args.symptom ? `Symptom: ${String(args.symptom)}` : undefined,
            "Start with `nifra_check`; use each diagnostic as the source of truth.",
            "Read `nifra://routes` for the exact typed-client calls and compact body/query/response shapes.",
            "Prefer `client<typeof app>` over hand-rolled internal `fetch`. Verify fixed endpoints with `nifra_run`.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
  ]
}

export function projectFeatures(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpServerFeatures {
  return { resources: projectResources(cwd, loadAppCached), prompts: projectPrompts() }
}

/**
 * Resolve an optional `dir` tool argument - a subdirectory of the project root the caller wants to scope a
 * check/test to (e.g. `nifra check` on `app/` when the MCP server's root is a monorepo). Returns the
 * absolute target, or `null` if `dir` escapes the root (a path-traversal guard: no `..` out, no absolute
 * path elsewhere). `undefined`/empty → the root itself.
 */
export function resolveProjectDir(root: string, dir: string | undefined): string | null {
  if (dir === undefined || dir === "") return root
  const target = resolve(root, dir)
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(root)
  } catch {
    const lexical = relative(root, target)
    return lexical === "" || (!lexical.startsWith("..") && !isAbsolute(lexical)) ? target : null
  }
  let probe = target
  const missing: string[] = []
  while (true) {
    try {
      const canonicalProbe = realpathSync(probe)
      const rel = relative(canonicalRoot, canonicalProbe)
      if (rel.startsWith("..") || isAbsolute(rel)) return null
      return missing.length === 0 ? canonicalProbe : resolve(canonicalProbe, ...missing.reverse())
    } catch {
      const parent = resolve(probe, "..")
      if (parent === probe) return null
      // `basename`, not a slice past `parent`: when `parent` is the filesystem root its trailing
      // separator is part of it, so `parent.length + 1` eats the first character of the segment and
      // the path gets rebuilt wrong.
      missing.push(basename(probe))
      probe = parent
    }
  }
}

/** Consistent error string for a `dir` that escapes the project root. */
export function dirError(dir: string | undefined): string {
  return JSON.stringify(
    { ok: false, error: `dir must be a subdirectory of the project root - "${dir}" escapes it.` },
    null,
    2,
  )
}

/** Build the project-scoped tools for `cwd`. */
export interface CommandMcpToolOptions {
  readonly cwd: string
  readonly loadAppCached?: () => Promise<LoadedApp>
}

/** Adapt one executable catalog spec to its MCP descriptor and project-scoped handler. */
export function namespaceForApp(
  name: string,
  tools: McpTool[],
  features: McpServerFeatures,
): { tools: McpTool[]; features: McpServerFeatures } {
  const prefix = `nifra_${name}_`
  const namespacedTools = tools.map((t) => ({
    ...t,
    name: t.name.startsWith("nifra_") ? t.name.replace(/^nifra_/, prefix) : `${name}_${t.name}`,
  }))
  const namespacedResources = (features.resources ?? []).map((r) => ({
    ...r,
    uri: r.uri.replace(/^nifra:\/\//, `nifra://${name}/`),
  }))
  const namespacedPrompts = (features.prompts ?? []).map((p) => ({
    ...p,
    name: p.name.replace(/^nifra_/, prefix),
  }))
  return {
    tools: namespacedTools,
    features: { resources: namespacedResources, prompts: namespacedPrompts },
  }
}

/**
 * Merge the backend-derived resources/prompts into `base` - and keep a project that cannot be loaded
 * from deciding whether the server starts at all.
 *
 * Resources and prompts are OPTIONAL capabilities extracted from the app's backend, so this load is a
 * best-effort enrichment. It was awaited unguarded, which made it a hard boot requirement: `loadApp`
 * needs a web config (`adapter` + `clientModule`) and a `routes/` directory, and a backend-only
 * project - the shape `create-nifra`'s DEFAULT template produces - has neither. On those projects the
 * throw escaped before the JSON-RPC loop began, so the server wrote nothing and exited. `nifra
 * init-agents` would happily register an `.mcp.json` pointing at a server that could never start, and
 * every tool went with it, including the twelve that never touch the app (docs, examples, types,
 * check, doctor, levels, test).
 *
 * Degrading costs only the backend resources/prompts. Tools that genuinely need the app still fail,
 * but per call, with their own message - which is a diagnosis instead of a silence.
 */
