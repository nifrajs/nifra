/**
 * What each `nifra mcp` project tool may do, as MCP tool annotations, and a description for each
 * input field its definition leaves bare. A host reads the annotations to decide which calls need
 * the user's confirmation, so a tool that can write a file or run project code must never look
 * read-only. The hints describe the tool for any input: a tool that writes only under a flag is a
 * writer. mcp-tool-meta.test.ts fails on a tool or a field missing here.
 */
import type { McpTool, McpToolAnnotations } from "./mcp-protocol.ts"

const READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
// Writes or overwrites project files, at least for some inputs.
const WRITE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}
// Runs project code, tests, builds or scripts, which can do anything that code does.
const EXECUTE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const DIR = "Project subdirectory to run in, relative to the project root this server serves."
const JSON_RESULT = "Return the structured JSON result instead of the human-readable report."
const CONFIG = "Config file to read instead of the project's default nifra.config.ts."
const TARGET = "Deploy target to judge against (bun, node, deno, cloudflare, vercel)."

interface ToolMeta {
  readonly annotations: McpToolAnnotations
  readonly fields?: Readonly<Record<string, string>>
}

/** Every project tool by name. The docs tools set their own annotations and are not repeated. */
export const PROJECT_TOOL_META: Readonly<Record<string, ToolMeta>> = {
  nifra_check: {
    annotations: READ,
    fields: {
      lintsOnly: "Skip tsc and run only the source lints, a near-instant pass.",
      json: JSON_RESULT,
      sarif: "Return the diagnostics as a SARIF 2.1.0 log.",
      maxDiagnostics: "Return at most this many diagnostics.",
      dir: DIR,
    },
  },
  nifra_review: {
    annotations: WRITE,
    fields: {
      strict: "Treat warnings as blocking.",
      diff: "Review only the files changed since this git ref, instead of the whole project.",
      sarif: "Also write the findings as SARIF 2.1.0 to this project-relative file.",
      fix: "Plan the registered recipes for the findings.",
      dryRun: "With fix: show the planned edits without writing them.",
      write: "With fix: apply the planned edits to the project's files.",
      json: JSON_RESULT,
    },
  },
  nifra_assure: {
    annotations: EXECUTE,
    fields: {
      config: CONFIG,
      bundle: "Build the deploy bundle and verify the routes it serves, not only the source.",
      strict: "Fail on a route whose evidence is a skip (implies bundle).",
      hydration: "Also check that every page hydrates without errors (implies bundle).",
      interact: "Also click through each page in a browser (implies bundle).",
      out: "Write the assurance bundle to this project-relative file (implies bundle).",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_levels: {
    annotations: EXECUTE,
    fields: {
      config: CONFIG,
      seed: "Deterministic seed for the L4 invariant run. Default 1.",
      min: "Fail when the project is below this level (0 to 4).",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_capabilities: {
    annotations: WRITE,
    fields: {
      action:
        "snapshot writes the capability lockfile, check compares the project with it, explain describes one route.",
      config: CONFIG,
      out: "snapshot: the project-relative lockfile to write.",
      lockfile: "check: the project-relative lockfile to compare against.",
      method: "explain: the route's HTTP method.",
      path: "explain: the route's path.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_manifest: {
    annotations: WRITE,
    fields: {
      action: "emit writes the route trust manifest, diff compares two manifests.",
      config: CONFIG,
      out: "emit: the project-relative file to write.",
      before: "diff: the project-relative manifest to compare from.",
      after: "diff: the project-relative manifest to compare to.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_routes: {
    annotations: READ,
    fields: {
      json: JSON_RESULT,
      graph: "Render the public route surface as a Mermaid graph.",
      modes: "Show each page route's render mode (static, isr, ssr), hydration and cache policy.",
      hooks: "List the hooks each backend route and each prefix's unmatched paths run.",
      since: "hooks: a project-relative saved hooks report to diff against.",
      target: `modes: ${TARGET}`,
      dir: DIR,
    },
  },
  nifra_context: {
    annotations: READ,
    fields: {
      path: "Only the routes whose path starts with this.",
      kind: "Only the API routes or only the page routes.",
      dir: DIR,
    },
  },
  nifra_doctor: {
    annotations: WRITE,
    fields: {
      json: JSON_RESULT,
      autoFix: "Write the safe local-version dependency fixes to package.json.",
      strict: "Fail when an applicable production-readiness guarantee is absent.",
      target: TARGET,
      dir: DIR,
    },
  },
  nifra_fix: {
    annotations: WRITE,
    fields: {
      code: "Apply only the recipe for this diagnostic code (for example NF-C007).",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_snapshot: {
    annotations: WRITE,
    fields: {
      out: "The project-relative file to write. Default api-snapshot.json.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_diff: {
    annotations: READ,
    fields: {
      baseline: "The project-relative snapshot to compare with. Default api-snapshot.json.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_contracts: {
    annotations: WRITE,
    fields: {
      action: "snapshot writes contracts.lock.json, check compares the routes with it.",
      out: "snapshot: the project-relative lock file to write.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_sync_manifest: { annotations: WRITE, fields: { json: JSON_RESULT, dir: DIR } },
  nifra_sync_routes: { annotations: WRITE, fields: { json: JSON_RESULT, dir: DIR } },
  nifra_prove: {
    annotations: READ,
    fields: {
      files: "The changed files to plan proofs for, project-relative.",
      minLevel: "The verification level (0 to 4) the stop condition requires.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_replay: {
    annotations: EXECUTE,
    fields: { file: "The project-relative verification metadata file to replay.", dir: DIR },
  },
  nifra_smoke: {
    annotations: EXECUTE,
    fields: {
      fixture: "The project-relative smoke fixture. Default nifra.smoke.ts.",
      inProcess: "Run against the app in this process instead of a started production server.",
      json: JSON_RESULT,
      dir: DIR,
    },
  },
  nifra_port: {
    annotations: READ,
    fields: {
      target: `${TARGET} Fails when a used feature is unsupported there.`,
      json: JSON_RESULT,
      ci: "Fail when a used feature is unsupported on the target.",
      strict: "Also fail on a feature the target supports only with a caveat.",
      dir: DIR,
    },
  },
  nifra_errors: { annotations: READ, fields: { json: JSON_RESULT } },
  nifra_logs: {
    annotations: READ,
    fields: {
      json: JSON_RESULT,
      level: "Only lines at these levels.",
      source: "Only the server's or only the browser's lines.",
    },
  },
  nifra_db_schema: { annotations: READ, fields: { json: JSON_RESULT } },
  nifra_db_query: { annotations: READ, fields: { json: JSON_RESULT } },
  nifra_db_role: { annotations: READ, fields: { json: JSON_RESULT } },
  nifra_verify: { annotations: EXECUTE },
  nifra_contract_proof: { annotations: READ },
  nifra_explain: { annotations: READ },
  nifra_inspect: { annotations: READ },
  nifra_openapi: { annotations: READ },
  nifra_run: {
    annotations: EXECUTE,
    fields: {
      requests:
        "The requests to run, in order: each a path, with an optional method, headers and JSON body.",
    },
  },
  nifra_render: {
    annotations: EXECUTE,
    fields: { requests: "The pages to render, in order: each a path, with optional headers." },
  },
  nifra_ws: { annotations: EXECUTE },
  nifra_test: { annotations: EXECUTE },
  nifra_scaffold: { annotations: WRITE },
  nifra_hydrate: { annotations: EXECUTE },
}

/** `tool` with its annotations and field descriptions from {@link PROJECT_TOOL_META}. A tool that
 * sets annotations itself keeps them, and so does a field that has a description. */
export function withToolMeta(tool: McpTool): McpTool {
  const meta = PROJECT_TOOL_META[tool.name]
  if (meta === undefined) return tool
  const annotated = { ...tool, annotations: tool.annotations ?? meta.annotations }
  const fields = meta.fields
  const properties = tool.inputSchema.properties
  if (fields === undefined || !isRecord(properties)) return annotated
  const described = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => {
      const description = fields[name]
      return description === undefined || !isRecord(property) || "description" in property
        ? [name, property]
        : [name, { ...property, description }]
    }),
  )
  return { ...annotated, inputSchema: { ...tool.inputSchema, properties: described } }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null
