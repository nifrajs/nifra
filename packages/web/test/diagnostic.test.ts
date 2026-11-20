import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCodeframe,
  buildDiagnostic,
  classify,
  DIAGNOSTIC_CATALOG,
  formatBuildLog,
  isConsoleDiagnostic,
  isHydrationMismatch,
  parseFrames,
  type SourceReader,
  thrownByNifra,
  topUserFrame,
} from "../src/diagnostic.ts"

// A fixed source used by the codeframe tests, so no disk is touched.
const SRC = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n"
const reader: SourceReader = (file) => (file === "/app/routes/index.tsx" ? SRC : undefined)

test("parseFrames reads the parenthesised, bare, and async shapes", () => {
  const stack = [
    "Error: boom",
    "    at loader (/app/routes/index.tsx:3:9)",
    "    at /app/src/data.ts:12:1",
    "    at async render (/app/render.ts:5:2)",
  ].join("\n")
  const frames = parseFrames(stack)
  expect(frames).toHaveLength(3)
  expect(frames[0]).toEqual({
    raw: "at loader (/app/routes/index.tsx:3:9)",
    file: "/app/routes/index.tsx",
    line: 3,
    column: 9,
  })
  expect(frames[1]?.file).toBe("/app/src/data.ts")
  expect(frames[2]?.file).toBe("/app/render.ts")
  expect(frames[2]?.line).toBe(5)
})

test("parseFrames strips file:// and ?v= suffixes, and keeps unmatched frames raw", () => {
  const stack = ["    at fn (file:///app/routes/x.tsx?v=abc123:7:4)", "    at <anonymous>"].join(
    "\n",
  )
  const frames = parseFrames(stack)
  expect(frames[0]?.file).toBe("/app/routes/x.tsx")
  expect(frames[0]?.line).toBe(7)
  // Unmatched frame retained with no location - nothing silently dropped.
  expect(frames[1]).toEqual({ raw: "at <anonymous>" })
})

test("topUserFrame skips node_modules, node: builtins, and out-of-root files", () => {
  const frames = parseFrames(
    [
      "    at internal (node:internal/process:1:1)",
      "    at lib (/app/node_modules/dep/index.js:2:2)",
      "    at away (/other/thing.ts:3:3)",
      "    at mine (/app/routes/index.tsx:4:4)",
    ].join("\n"),
  )
  expect(topUserFrame(frames, "/app")?.file).toBe("/app/routes/index.tsx")
  // With no root, node_modules/node: are still excluded, so /other wins first.
  expect(topUserFrame(frames, undefined)?.file).toBe("/other/thing.ts")
})

test("topUserFrame enforces a real path boundary instead of a string prefix", () => {
  const frames = parseFrames(
    [
      "    at sibling (/app-evil/secret.ts:1:1)",
      "    at traversal (/app/routes/../secret.ts:2:2)",
      "    at mine (/app/routes/index.tsx:3:3)",
    ].join("\n"),
  )
  expect(topUserFrame(frames, "/app/routes")?.file).toBe("/app/routes/index.tsx")
})

test("topUserFrame returns undefined when every frame is dependency/runtime", () => {
  const frames = parseFrames("    at x (/app/node_modules/a/b.js:1:1)\n    at y (node:fs:2:2)")
  expect(topUserFrame(frames, "/app")).toBeUndefined()
})

test("buildCodeframe windows around the line, marks the caret, and clamps at the edges", () => {
  const frame = buildCodeframe("/app/routes/index.tsx", 4, 2, reader, 2)
  expect(frame?.lines.map((l) => l.number)).toEqual([2, 3, 4, 5, 6])
  expect(frame?.lines.find((l) => l.caret)?.number).toBe(4)
  // Clamp at the top: line 1 with radius 3 starts at 1, never 0/negative.
  expect(buildCodeframe("/app/routes/index.tsx", 1, undefined, reader, 3)?.lines[0]?.number).toBe(1)
})

test("buildCodeframe returns undefined for an unreadable file or an out-of-range line", () => {
  expect(buildCodeframe("/missing.tsx", 3, 1, reader)).toBeUndefined()
  expect(buildCodeframe("/app/routes/index.tsx", 999, 1, reader)).toBeUndefined()
  expect(buildCodeframe("/app/routes/index.tsx", 0, 1, reader)).toBeUndefined()
})

test("buildCodeframe falls back to the filesystem reader for a missing file (no throw)", () => {
  // Exercises the default reader path without asserting content - a nonexistent path yields undefined.
  expect(buildCodeframe("/definitely/not/here.tsx", 1, 1)).toBeUndefined()
})

test("classify recognises the seeded failure shapes and falls back to unhandled", () => {
  expect(classify("Error", "backend-only module(s) in the client bundle: ...").code).toBe(
    "NIFRA_BACKEND_ONLY_IN_CLIENT",
  )
  expect(
    classify("Error", "[nifra/web] the browser build reached code that may not ship to a browser:")
      .code,
  ).toBe("NIFRA_BACKEND_IN_CLIENT")
  expect(classify("Error", "[nifra] backend/db.ts may not reach the browser: x").code).toBe(
    "NIFRA_BACKEND_IN_CLIENT",
  )
  expect(classify("Error", "Node built-in(s) in the client bundle").code).toBe(
    "NIFRA_NODE_BUILTIN_IN_CLIENT",
  )
  expect(classify("SchemaError", "whatever").code).toBe("NIFRA_SCHEMA_PARSE")
  const generic = classify("TypeError", "x is not a function")
  expect(generic.code).toBe("NIFRA_UNHANDLED")
  expect(generic.fix).toBeUndefined()
})

test("a Solid 2.0 dev report classifies under its own code and is a console diagnostic", () => {
  const report = [
    "[STRICT_READ_UNTRACKED] Reactive value read directly in an effect callback will not update.",
    "in <App> › <Item> › effect",
    "at http://localhost:5173/src/Item.tsx:12:19",
    "[STRICT_READ_UNTRACKED] what it means and how to fix it: https://docs.solidjs.com/reference/solid-js/diagnostics/strict-read-untracked",
    "[STRICT_READ_UNTRACKED] agent repair guide: node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md#strict_read_untracked",
  ].join("\n")
  expect(classify("Warning", report).code).toBe("NIFRA_SOLID_DIAGNOSTIC")
  expect(isConsoleDiagnostic(report)).toBe(true)
  // A bracketed prefix alone, with no Solid guide line, is someone else's log.
  expect(classify("Warning", "[vite] connected").code).toBe("NIFRA_UNHANDLED")
  expect(isConsoleDiagnostic("[vite] connected")).toBe(false)
})

test("the failures web throws most classify under a feature code", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["ServerComponentError", "[nifra/web] component_input", "NIFRA_COMPONENT_REQUEST"],
    ["Error", "[nifra/components] Exactly one client entry is required", "NIFRA_COMPONENT_BUILD"],
    [
      "Error",
      '[nifra/web] ppr: route "/shop" has a shellLoader, but its layout "/" has a loader that is not a gate.',
      "NIFRA_PPR_CONTRACT",
    ],
    ["TypeError", "[nifra/web] ppr.deployment must be a non-empty string", "NIFRA_PPR_CONTRACT"],
    [
      "Error",
      "[nifra/web] deployment output contains a symbolic link: out/x",
      "NIFRA_DEPLOYMENT_OUTPUT",
    ],
    [
      "TypeError",
      "[nifra/web] live: `hub` and `bus` are exclusive; the hub owns the log",
      "NIFRA_LIVE_CONFIG",
    ],
    [
      "Error",
      "[nifra/web] route-slot name is not registered on this route",
      "NIFRA_ROUTE_SLOT_UNAVAILABLE",
    ],
    [
      "Error",
      "[nifra/web] the client build produced no module graph (metafile), so nifra cannot prove it",
      "NIFRA_CLIENT_BUILD_NO_GRAPH",
    ],
    [
      "RangeError",
      "[nifra/web/cdn] sMaxAge must be a non-negative integer number of seconds",
      "NIFRA_CDN_CONFIG",
    ],
    [
      "Error",
      "loadGoogleFont: invalid family x (letters, digits, and spaces only)",
      "NIFRA_OPTION_INVALID",
    ],
    ["Error", "[nifra] unhandled request error", "NIFRA_UNHANDLED"],
  ]
  for (const [name, message, code] of cases) expect(classify(name, message).code).toBe(code)
})

test("React, Vue and Svelte dev warnings classify under their framework's code", () => {
  const vue = '[Vue warn]: Missing required prop: "id"\n  at <Item>'
  const svelte =
    "[svelte] assignment_value_stale\nAssignment to `x` will evaluate to the right-hand side.\nhttps://svelte.dev/e/assignment_value_stale"
  const react =
    'Each child in a list should have a unique "key" prop. See https://react.dev/link/warning-keys for more information.'
  expect(classify("Warning", vue).code).toBe("NIFRA_VUE_WARNING")
  expect(classify("Warning", svelte).code).toBe("NIFRA_SVELTE_DIAGNOSTIC")
  expect(classify("Warning", react).code).toBe("NIFRA_REACT_WARNING")
  for (const message of [vue, svelte, react]) expect(isConsoleDiagnostic(message)).toBe(true)
  // A hydration mismatch keeps its own code whichever framework reports it.
  expect(
    classify("Warning", "[Vue warn]: Hydration node mismatch\n- rendered on server").code,
  ).not.toBe("NIFRA_VUE_WARNING")
})

test("a validation message is a nifra failure only when nifra threw it", () => {
  expect(classify("Error", "rateLimit: max must be a positive integer").code).toBe(
    "NIFRA_UNHANDLED",
  )
  expect(classify("Error", "rateLimit: max must be a positive integer", true).code).toBe(
    "NIFRA_OPTION_INVALID",
  )
  expect(classify("Error", "saga checkout: not found").code).toBe("NIFRA_UNHANDLED")
  expect(classify("Error", "saga checkout: not found", true).code).toBe("NIFRA_EFFECT_INVALID")
  const stack = (file: string): string =>
    `Error: rateLimit: max must be a positive integer\n    at rateLimit (${file}:10:3)\n    at boot (/app/server.ts:4:1)`
  expect(
    thrownByNifra(parseFrames(stack("/app/node_modules/@nifrajs/middleware/dist/index.js"))),
  ).toBe(true)
  expect(thrownByNifra(parseFrames(stack("/app/lib/limits.ts")))).toBe(false)
  const thrown = (file: string): string => {
    const err = new Error("rateLimit: max must be a positive integer")
    err.stack = stack(file)
    return buildDiagnostic(err, { root: "/app", read: reader }).code
  }
  expect(thrown("/app/node_modules/@nifrajs/middleware/dist/index.js")).toBe("NIFRA_OPTION_INVALID")
  expect(thrown("/app/lib/limits.ts")).toBe("NIFRA_UNHANDLED")
})

test("the production and configuration traps carry their own code", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "Error",
      "MemoryStore is per-instance and unsafe in production (each instance limits separately). Use a shared store",
      "NIFRA_MEMORY_STORE_IN_PRODUCTION",
    ],
    [
      "Error",
      "[nifra/auth] MemorySessionStore is per-instance and unsafe in production (sessions don't hold",
      "NIFRA_MEMORY_STORE_IN_PRODUCTION",
    ],
    [
      "Error",
      'cors: `credentials: true` cannot be combined with `origin: "*"` - list explicit origin(s).',
      "NIFRA_CORS_CREDENTIALS_WILDCARD",
    ],
    ["Error", "csrf: secret must be at least 32 bytes", "NIFRA_SECRET_TOO_SHORT"],
    [
      "Error",
      "idempotency must be installed before the routes it protects",
      "NIFRA_MIDDLEWARE_ORDER",
    ],
    [
      "Error",
      "contextStorage: no active context. Add app.use(contextStorage())",
      "NIFRA_CONTEXT_STORAGE_MISSING",
    ],
    ["RouteConfigError", "[nifra] duplicate route GET /a", "NIFRA_ROUTE_CONFIG"],
    ["StorageKeyError", "storage key ../x escapes the storage root", "NIFRA_STORAGE_KEY"],
    ["StorageKeyError", "storage path crosses a symbolic link: uploads", "NIFRA_STORAGE_KEY"],
    ["RangeError", "R2Storage object exceeds maxReadBytes", "NIFRA_STORAGE_READ_LIMIT"],
    ["OpenAPIImportError", "document.paths must be an object", "NIFRA_OPENAPI_IMPORT"],
  ]
  for (const [name, message, code] of cases) expect(classify(name, message).code).toBe(code)
})

test("a framework's development warning is a warning; a Solid error code and a thrown Preact error are not", () => {
  const solid = (code: string): string =>
    `[${code}] observed\nin <App> › effect\nat src/a.tsx:1:1\n[${code}] what it means and how to fix it: https://docs.solidjs.com/reference/solid-js/diagnostics/x\n[${code}] agent repair guide: node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md#x`
  expect(classify("Warning", solid("STRICT_READ_UNTRACKED")).severity).toBe("warning")
  expect(classify("Warning", solid("REACTIVE_WRITE_IN_OWNED_SCOPE")).severity).toBeUndefined()
  expect(classify("Warning", "[Vue warn]: Missing required prop").severity).toBe("warning")
  // React: a react.dev/link or a legacy "Warning:" is a warning; an errors link or a minified error is thrown.
  const link = "Each child in a list should have a unique key. https://react.dev/link/warning-keys"
  expect(classify("Error", link)).toMatchObject({
    code: "NIFRA_REACT_WARNING",
    severity: "warning",
  })
  expect(
    classify("Warning", "Warning: Each child in a list should have a unique key").severity,
  ).toBe("warning")
  const thrown = "Minified React error #31; visit https://react.dev/errors/31 for the full message"
  expect(classify("Error", thrown).code).toBe("NIFRA_REACT_WARNING")
  expect(classify("Error", thrown).severity).toBeUndefined()
  expect(classify("Error", "Minified React error #31").severity).toBeUndefined()
  expect(classify("Error", "Undefined component passed to createElement()").code).toBe(
    "NIFRA_PREACT_DIAGNOSTIC",
  )
  expect(
    classify("Error", "Undefined component passed to createElement()").severity,
  ).toBeUndefined()
  expect(
    classify("Warning", "Following component has two or more children with the same key").severity,
  ).toBe("warning")
  // A failure that is not a warning carries no severity, and an absent field is dropped from JSON.
  expect(classify("Error", "contextStorage: no active context").severity).toBeUndefined()
  const plain = buildDiagnostic(new Error("x is not a function"), { read: reader })
  expect(plain.severity).toBeUndefined()
  expect(JSON.stringify(plain)).not.toContain("severity")
})

test("the remaining configuration families classify, for nifra's own errors only", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["Error", "[nifra] cookie Domain contains an illegal character", "NIFRA_HEADER_VALUE_INVALID"],
    [
      "FrameworkError",
      "[nifra] app.ws() needs the WebSocket runtime, which ships as an opt-in plugin so no-WebSocket apps stay lean.",
      "NIFRA_RUNTIME_MISSING",
    ],
    [
      "FrameworkError",
      "[nifra] a Bun server with mounted WebSocket routes needs the websocket() runtime installed on the parent or child app",
      "NIFRA_RUNTIME_MISSING",
    ],
    [
      "FrameworkError",
      "[nifra] afterHandle() at src/app.ts:3 was added after createWebApp declared the page routes, so no page runs it",
      "NIFRA_SERVER_LIFECYCLE",
    ],
    [
      "FrameworkError",
      "[nifra] server configuration is sealed after listen() (a group once its builder returns); call get before",
      "NIFRA_SERVER_LIFECYCLE",
    ],
    [
      "FrameworkError",
      "[nifra] listen() uses Bun.serve and runs only on Bun. Serve on Node with @nifrajs/node",
      "NIFRA_SERVER_LIFECYCLE",
    ],
    [
      "TypeError",
      "[nifra/web] createWebApp `cspHeader` writes the header of `nonce` documents",
      "NIFRA_CSP_CONFIG",
    ],
    ["TypeError", "[nifra/web/cdn] this store cannot invalidate by tag", "NIFRA_CDN_CONFIG"],
    ["Error", "around next() called multiple times", "NIFRA_API_MISUSE"],
    ["RangeError", "ws.close(): the reason is over 123 UTF-8 bytes", "NIFRA_WEBSOCKET_INVALID"],
    ["TypeError", "Do not know how to serialize a BigInt", "NIFRA_VALUE_NOT_SERIALIZABLE"],
    ["CronError", "expected 5 space-separated fields (got 3)", "NIFRA_CRON_INVALID"],
    [
      "TypeError",
      'bodyParser: "application/json" is JSON, which every body schema already reads',
      "NIFRA_BODY_PARSER_REFUSED",
    ],
    ["Error", "jwks: fetch failed with 503", "NIFRA_JWKS_UNAVAILABLE"],
    [
      "TypeError",
      "[nifra/node] `signals` is now `gracefulSignals`, as on Bun's server options",
      "NIFRA_OPTION_RENAMED",
    ],
    ["Error", "[nifra/web] action failed (500): /orders", "NIFRA_ACTION_FAILED"],
    ["Error", '[nifra/web] overlapping routes: "/a" and "/b" both match', "NIFRA_ROUTE_FILES"],
  ]
  for (const [name, message, code] of cases) expect(classify(name, message, true).code).toBe(code)
  // The same words from the app's own code are not a nifra failure (a class only nifra defines is
  // recognised by its name wherever it is thrown).
  const generic = (name: string): boolean => ["Error", "TypeError", "RangeError"].includes(name)
  for (const [name, message] of cases.filter(
    ([kind, text]) => generic(kind) && !text.startsWith("[nifra"),
  ))
    expect(classify(name, message, false).code).toBe("NIFRA_UNHANDLED")
})

test("every catalog entry carries a cause, fix, and docs anchor", () => {
  for (const entry of DIAGNOSTIC_CATALOG) {
    expect(entry.code.startsWith("NIFRA_")).toBe(true)
    expect(entry.cause.length).toBeGreaterThan(0)
    expect(entry.fix.length).toBeGreaterThan(0)
    expect(entry.docsAnchor).toContain("errors#")
  }
})

test("buildDiagnostic resolves a recognised error end to end with a codeframe", () => {
  const err = new Error("backend-only module(s) in the client bundle: /app/secrets.ts")
  err.stack = [
    "Error: backend-only module(s) in the client bundle: /app/secrets.ts",
    "    at loader (/app/node_modules/@nifrajs/web/dist/build.js:1:1)",
    "    at handler (/app/routes/index.tsx:3:9)",
  ].join("\n")
  const diag = buildDiagnostic(err, {
    request: { method: "GET", url: "/" },
    root: "/app",
    read: reader,
  })
  expect(diag.code).toBe("NIFRA_BACKEND_ONLY_IN_CLIENT")
  expect(diag.request).toEqual({ method: "GET", url: "/" })
  expect(diag.codeframe?.file).toBe("/app/routes/index.tsx")
  expect(diag.codeframe?.line).toBe(3)
  expect(diag.fix).toContain("backend/")
  expect(diag.docsAnchor).toBe("errors#backend-only-in-client")
})

test("buildDiagnostic tolerates a non-Error throw and a stackless error", () => {
  const fromString = buildDiagnostic("plain string boom", { root: "/app", read: reader })
  expect(fromString.name).toBe("Error")
  expect(fromString.message).toContain("plain string boom")
  expect(fromString.code).toBe("NIFRA_UNHANDLED")

  const noStack = new Error("no frames here")
  noStack.stack = "Error: no frames here" // a message-only stack: no `at` frames to parse
  const diag = buildDiagnostic(noStack, { root: "/app", read: reader })
  expect(diag.message).toBe("no frames here")
  expect(diag.codeframe).toBeUndefined()
  expect(diag.frames).toEqual([])
})

test("hydration reports from each framework classify, and a flag name that only mentions one does not", () => {
  for (const message of [
    "Hydration failed because the server rendered text didn't match the client.",
    "[Vue warn]: Hydration text content mismatch on <p#rendered>",
    "Hydration completed but contains mismatches.",
    "[svelte] hydration_mismatch\nHydration failed because the initial UI does not match",
    "[svelte] hydration_html_changed\nThe value of an `{@html ...}` block changed between server and client renders",
    "Unable to find DOM nodes for hydration key: 0-0-1",
  ]) {
    expect(isHydrationMismatch(message)).toBe(true)
  }
  expect(
    isHydrationMismatch(
      "Feature flags __VUE_OPTIONS_API__, __VUE_PROD_DEVTOOLS__, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__ are not explicitly defined.",
    ),
  ).toBe(false)
})

test("formatBuildLog names the file, line and column a Bun build failure points at", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-build-log-"))
  try {
    await writeFile(join(root, "page.ts"), 'import { rows } from "./db"\nconsole.log(rows)\n')
    await writeFile(join(root, "broken.ts"), "const x = (\n")
    const resolved = await Bun.build({ entrypoints: [join(root, "page.ts")], throw: false })
    expect(resolved.logs.map((log) => formatBuildLog(log, root))).toEqual([
      'page.ts:1:22: Could not resolve: "./db"\n    import { rows } from "./db"',
    ])
    const parsed = await Bun.build({ entrypoints: [join(root, "broken.ts")], throw: false })
    expect(formatBuildLog(parsed.logs[0], root)).toStartWith("broken.ts:1:")
    // A thrown build carries the same messages in an AggregateError.
    const thrown: unknown = await Bun.build({ entrypoints: [join(root, "page.ts")] }).catch(
      (error: unknown) => error,
    )
    expect(thrown).toBeInstanceOf(AggregateError)
    const errors: unknown[] = thrown instanceof AggregateError ? thrown.errors : []
    expect(formatBuildLog(errors[0], root)).toStartWith("page.ts:1:22:")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("formatBuildLog keeps an absolute path outside the root, and a plain message without a position", () => {
  const log = { message: "boom", position: { file: "/elsewhere/x.ts", line: 3, column: 1 } }
  expect(formatBuildLog(log, "/app")).toBe("/elsewhere/x.ts:3:1: boom")
  const sibling = { message: "boom", position: { file: "/app-other/x.ts", line: 1, column: 1 } }
  expect(formatBuildLog(sibling, "/app")).toBe("/app-other/x.ts:1:1: boom")
  // A name that only starts with two dots is still inside the root.
  const dotted = { message: "boom", position: { file: "/app/..page.ts", line: 2, column: 5 } }
  expect(formatBuildLog(dotted, "/app")).toBe("..page.ts:2:5: boom")
  expect(formatBuildLog(new Error("plain"), "/app")).toBe("plain")
  expect(formatBuildLog("text", "/app")).toBe("text")
})
