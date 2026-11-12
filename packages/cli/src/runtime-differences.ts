/**
 * `nifra_runtime` - a symptom-indexed catalog of the places where Bun, Node, Deno and Cloudflare
 * Workers answer the same request, call or flag differently. None of them is Nifra's doing: they are
 * behaviors of the runtimes Nifra runs on. Where Nifra has a switch that decides which one an app
 * gets, the entry names it.
 *
 * The runtime-side companion to `nifra_frontend`: that catalog covers the browser and the frontend
 * frameworks, this one covers the server runtime. One source, two heads - `nifra_runtime` (MCP) and
 * `nifra runtime` (CLI) both call {@link renderRuntimeResult}, so they cannot drift.
 *
 * Every entry records the versions it was measured on. A runtime release can change one; when it
 * does, update the entry and its `versions` rather than adding a second one.
 */

import { rankBySymptom, symptomQuery } from "./symptom-search.ts"

/** A runtime an entry applies to, or `all` for a difference every runtime shows. */
export type RuntimeName = "bun" | "node" | "deno" | "workerd" | "all"

export interface RuntimeEntry {
  /** Stable slug, e.g. `pipelined-requests`. */
  readonly id: string
  /** Which runtimes show the difference. */
  readonly runtimes: readonly RuntimeName[]
  /** What you observe - the searchable symptom, phrased as the failure, not the cause. */
  readonly symptom: string
  /** What each runtime does. */
  readonly cause: string
  /** What to do, including the Nifra option that decides it when there is one. */
  readonly fix: string
  /** How to confirm it on your own runtime. */
  readonly verify: string
  /** Where to go deeper - a `nifra_docs` query. */
  readonly seeAlso?: string | undefined
  /** The runtime versions the entry was measured on. */
  readonly versions: readonly string[]
  /** Coarse category used by JSON consumers to group related cases. */
  readonly category: "request" | "response" | "language" | "process" | "files" | "edge"
}

export interface RuntimeResult {
  readonly schemaVersion: 1
  readonly runtime?: RuntimeName | undefined
  readonly symptom?: string | undefined
  readonly matched: boolean
  readonly entries: readonly RuntimeEntry[]
}

const MEASURED = ["Bun 1.4.4", "Node 26.12", "Deno 2.9.8"] as const

export const RUNTIME_DIFFERENCES: readonly RuntimeEntry[] = [
  {
    id: "dot-segment-targets",
    runtimes: ["bun", "node", "deno", "workerd"],
    symptom:
      "A path guard on `/admin` is skipped, or one request reaches different routes on different runtimes: `GET /public/../admin` or `/users/%2e%2e/9`.",
    cause:
      "Bun and Cloudflare Workers hand the app a URL their parser has already resolved, so `/public/../admin` arrives as `/admin`. Deno's `Request.url` and Node's `IncomingMessage.url` carry the target exactly as the client sent it, dot segments included.",
    fix: "Set `normalizeTarget: true` (`server({ normalizeTarget: true })` on Deno, `serve(app, { normalizeTarget: true })` from `@nifrajs/node`) so Nifra resolves dot segments, backslashes and the characters a URL parser percent-encodes before routing. It is off by default because it costs about 3% of a bare route on Deno. Turn it on when guards or proxies upstream use a different path policy, or when your path guards run after Nifra normalizes the target. Or normalize paths in the proxy in front of the app.",
    verify:
      "Send the raw target with `curl --path-as-is http://host/public/../admin` to each runtime and compare the route that answers.",
    seeAlso: "normalizeTarget request target dot segments",
    versions: MEASURED,
    category: "request",
  },
  {
    id: "host-builds-url",
    runtimes: ["deno", "bun"],
    symptom:
      "`c.req.url` points at a path the client did not ask for, or is a relative string, after a request with an odd `Host` header such as `Host: h.test/admin#`.",
    cause:
      "With `Host: h.test/admin#` and no options set, Deno builds `Request.url` from the Host as received and routes `/admin`, Bun leaves `c.req.url` relative (`/url`), and `@nifrajs/node` answers `400 Bad Request`.",
    fix: "Set `validateHost: true` so Nifra answers `400 invalid_host` for a Host the request target cannot safely be built on. Off by default: reading the Host header measured about 6% of a bare route on Bun.",
    verify:
      "`printf 'GET /url HTTP/1.1\\r\\nhost: h.test/admin#\\r\\n\\r\\n' | nc 127.0.0.1 <port>` against a route that echoes `c.req.url`.",
    seeAlso: "validateHost invalid_host Host header",
    versions: MEASURED,
    category: "request",
  },
  {
    id: "missing-or-repeated-host",
    runtimes: ["bun", "node", "deno"],
    symptom:
      "`new URL(c.req.url)` throws, or the request is answered 400, for an HTTP/1.0 request with no Host or a request that sends Host twice.",
    cause:
      "With no Host (HTTP/1.0), `c.req.url` is relative (`/url`) on Bun, `http://localhost/url` through `@nifrajs/node`, and `http://localhost:<port>/url` on Deno. With `Host: a.test` and `Host: b.test`, Bun builds the URL on the first, while `@nifrajs/node` and Deno answer `400`.",
    fix: "Parse against a base when you must, `new URL(c.req.url, base)`, or enable `validateHost: true` so Nifra refuses the malformed Hosts it can see with a `400`. Do not use the Host header for security decisions.",
    verify:
      "Send `GET /url HTTP/1.0` with no Host, and a request with two Host lines, to a route that echoes `c.req.url` and the `host` header.",
    seeAlso: "validateHost Host header relative url",
    versions: MEASURED,
    category: "request",
  },
  {
    id: "pipelined-requests",
    runtimes: ["node", "bun", "deno"],
    symptom:
      "A client that writes many requests down one connection without waiting makes a Node server run all their handlers at once, using far more memory than on Bun or Deno.",
    cause:
      "Node's `http` server dispatches every pipelined request it has parsed: 30 requests in one write ran 30 handlers concurrently through `@nifrajs/node`. Bun and Deno ran one at a time per connection.",
    fix: "Bound per-connection work yourself on Node: cap buffered response size, use `requestTimeoutMs`, and put a connection or concurrency limit in the proxy in front. Measure with unread pipelined load, not only one slow client.",
    verify:
      "Write 30 `GET` requests in one `socket.write`, never read, and count handlers running at once with an in-flight counter.",
    seeAlso: "requestTimeoutMs slow client capacity",
    versions: MEASURED,
    category: "request",
  },
  {
    id: "json-content-type",
    runtimes: ["bun", "node", "deno"],
    symptom:
      "A test or client that compares the `content-type` of a JSON response exactly passes on one runtime and fails on another.",
    cause:
      "`Response.json(...)` sets `application/json;charset=utf-8` on Bun and `application/json` on Node (undici) and Deno, and Nifra keeps each runtime's own value: the same route answered `application/json;charset=utf-8` on Bun and `application/json` on Node and Deno.",
    fix: "Compare the media type, not the whole header: `contentType.split(';')[0]` or `startsWith('application/json')`. When you must pin one value, set the header yourself on every response.",
    verify:
      "Return `Response.json({ a: 1 })` and print `response.headers.get('content-type')` on each runtime.",
    seeAlso: "response content-type json headers",
    versions: MEASURED,
    category: "response",
  },
  {
    id: "engine-error-messages",
    runtimes: ["bun", "node", "deno"],
    symptom:
      "A test or log filter that matches an error message from `JSON.parse`, `new URL` or a property read on `null` breaks when the app moves runtime.",
    cause:
      "Bun runs JavaScriptCore; Node and Deno run V8. `JSON.parse('{')` reads `JSON Parse error: Expected '}'` on Bun and `Expected property name or '}' in JSON at position 1 (line 1 column 2)` on Node and Deno. `new URL('not a url')` says `Invalid URL` on Bun and Node and `Invalid URL: 'not a url'` on Deno. `null.x` reads `null is not an object (evaluating 'null.x')` on Bun and `Cannot read properties of null (reading 'x')` elsewhere.",
    fix: "Match on the error's class or an app-owned code, never its message. Nifra's own client errors carry stable codes; use those, not text from the runtime.",
    verify: "Run the snippet in each runtime's REPL and print `error.message`.",
    seeAlso: "errors error codes structured",
    versions: MEASURED,
    category: "language",
  },
  {
    id: "deep-recursion",
    runtimes: ["bun", "node", "deno"],
    symptom:
      "A recursive helper works on Bun with 200,000 levels and throws `RangeError: Maximum call stack size exceeded` on Node or Deno at roughly 10,000.",
    cause:
      "JavaScriptCore runs `return f()` as a proper tail call, so a tail-recursive function never grows the stack on Bun. V8 does not, so Node and Deno overflow, in this probe somewhere between 9,000 and 20,000 frames.",
    fix: "Iterate with a loop, or re-enter only after an `await`. Run any stack-depth test on Node (or Deno), not only Bun.",
    verify:
      "`const f = (n) => (n === 0 ? 0 : f(n - 1)); f(20000)` in each runtime; it returns on Bun and throws on Node.",
    seeAlso: "stack depth recursion middleware chain",
    versions: MEASURED,
    category: "language",
  },
  {
    id: "dotenv-autoload",
    runtimes: ["bun", "node", "deno"],
    symptom:
      "An app reads `process.env.X` from a `.env` file in development on Bun, and gets `undefined` on Node or Deno.",
    cause:
      "Bun loads `.env`, `.env.local` and the mode-specific files from the working directory at startup. Node and Deno load nothing unless started with `--env-file=.env`.",
    fix: "Pass `--env-file` on Node and Deno (and `nifra`'s own `--env-file`), or set the variables in the environment. Use `bun --no-env-file` when a Bun process must not inherit a file's values.",
    verify:
      "Put `X=1` in `.env` and print the value with `bun`, `node` and `deno run -A` from the same directory; add `--env-file=.env` to the last two.",
    seeAlso: "environment variables env file deployment",
    versions: MEASURED,
    category: "process",
  },
  {
    id: "spawn-env",
    runtimes: ["bun"],
    symptom:
      "A child process started with `Bun.spawn` does not see an environment variable the parent set after startup.",
    cause:
      "Without an `env` option, `Bun.spawn` passes the environment Bun started with, not later `process.env` assignments. Node's `child_process` uses the live `process.env`.",
    fix: "Pass `env: process.env` (or an explicit object) to every `Bun.spawn` and `Bun.spawnSync` call that depends on a variable you changed.",
    verify:
      "Set `process.env.Y = 'y'`, spawn `sh -c 'echo $Y'` with and without `env: process.env`, and compare.",
    seeAlso: "environment variables child process",
    versions: ["Bun 1.4.4"],
    category: "process",
  },
  {
    id: "glob-symlinks",
    runtimes: ["bun"],
    symptom:
      "`Bun.Glob` finds fewer files than a shell glob: symlinked files and the contents of symlinked directories are missing.",
    cause:
      "`new Bun.Glob(pattern).scanSync({ cwd })` skips symlinks entirely unless `followSymlinks: true` is set. In the probe, a tree with one real file, a symlinked file and a symlinked directory returned only the real file.",
    fix: "Set `followSymlinks` on purpose. Leave it off when the scan is a write or deletion boundary, and say so in a comment.",
    verify:
      "Create a real file, a symlink to it and a symlinked directory, and compare `scanSync` with and without `followSymlinks: true`.",
    seeAlso: "file scanning glob",
    versions: ["Bun 1.4.4"],
    category: "files",
  },
  {
    id: "workerd-node-builtins",
    runtimes: ["workerd"],
    symptom:
      "A Worker that imports `node:async_hooks` (or another Node builtin) fails to start on an older `compatibility_date`, or works on a newer one without `nodejs_compat`.",
    cause:
      "Which `node:` builtins a Cloudflare Worker gets without the `nodejs_compat` flag depends on its `compatibility_date`. With the 2026-08-18 date, `import 'node:async_hooks'` works. With 2024-06-01, the Worker fails to start on that import, and `process` is undefined.",
    fix: "Do not `import` a Node builtin in code that also runs on Workers. Look it up lazily behind a guard, `typeof process !== 'undefined' ? process.getBuiltinModule('node:async_hooks') : undefined`, and handle `undefined`: `process` does not exist on an old date without Node compatibility. Set the compatibility date and flags in `wrangler.toml` deliberately.",
    verify:
      "Run the Worker under `wrangler dev` with each `compatibility_date` and check that it starts and the lookup returns a module or `undefined`.",
    seeAlso: "cloudflare workers edge nodejs_compat compatibility date",
    versions: ["wrangler dev (measured 2026-10-10)"],
    category: "edge",
  },
]

const RUNTIME_ALIASES: Record<string, RuntimeName> = {
  all: "all",
  bun: "bun",
  node: "node",
  nodejs: "node",
  deno: "deno",
  workerd: "workerd",
  workers: "workerd",
  cloudflare: "workerd",
}

/** Normalize a free-text runtime argument to a known runtime, or `undefined` if it is not one. */
export function parseRuntime(value: string | undefined): RuntimeName | undefined {
  if (value === undefined) return undefined
  return RUNTIME_ALIASES[value.trim().toLowerCase()]
}

const appliesTo = (entry: RuntimeEntry, runtime: RuntimeName): boolean =>
  runtime === "all" || entry.runtimes.includes("all") || entry.runtimes.includes(runtime)

function scopedEntries(runtime: RuntimeName | undefined): readonly RuntimeEntry[] {
  return runtime === undefined
    ? RUNTIME_DIFFERENCES
    : RUNTIME_DIFFERENCES.filter((entry) => appliesTo(entry, runtime))
}

function score(entry: RuntimeEntry, words: readonly string[]): number {
  const hay =
    `${entry.id} ${entry.symptom} ${entry.cause} ${entry.fix} ${entry.seeAlso ?? ""} ${entry.category} ${entry.versions.join(" ")}`.toLowerCase()
  let hits = 0
  for (const w of words) if (hay.includes(w)) hits++
  return hits
}

/** Select the entries rendered by the CLI and MCP heads; also the stable JSON shape for agents. */
export function selectRuntimeDifferences(args: {
  runtime?: string | undefined
  symptom?: string | undefined
  limit?: number | undefined
}): RuntimeResult {
  const runtime = parseRuntime(args.runtime)
  const scoped = scopedEntries(runtime)
  const query = symptomQuery(args.symptom)
  if (query === undefined) {
    return { schemaVersion: 1, runtime, matched: true, entries: scoped }
  }
  const entries = rankBySymptom(scoped, query, args.limit, score)
  return { schemaVersion: 1, runtime, symptom: query, matched: entries.length > 0, entries }
}

function renderEntry(entry: RuntimeEntry): string {
  const scope = entry.runtimes.includes("all") ? "all runtimes" : entry.runtimes.join(", ")
  const parts = [
    `[${entry.id}]  (${scope})`,
    `Symptom: ${entry.symptom}`,
    `Cause:   ${entry.cause}`,
    `Fix:     ${entry.fix}`,
    `Verify:  ${entry.verify}`,
    `Measured: ${entry.versions.join(", ")}`,
    `Category: ${entry.category}`,
  ]
  if (entry.seeAlso !== undefined) parts.push(`See:     ${entry.seeAlso}`)
  return parts.join("\n")
}

function renderIndex(entries: readonly RuntimeEntry[], runtime: RuntimeName | undefined): string {
  const scope = runtime === undefined ? "all runtimes" : `runtime: ${runtime}`
  const lines = entries.map((e) => {
    const s = e.runtimes.includes("all") ? "all" : e.runtimes.join("/")
    return `- ${e.id} (${s}) - ${e.symptom}`
  })
  return [
    `nifra runtime differences (${entries.length} of ${RUNTIME_DIFFERENCES.length}, ${scope}). Pass a symptom to get the cause + fix + how to verify; pass a runtime to filter.`,
    "",
    ...lines,
  ].join("\n")
}

/**
 * Render the catalog. Filters by `runtime` (when it names a known one), then by a `symptom` keyword
 * query. With no query it returns the (filtered) index; with a query it returns the best-matching
 * entries in full, or the index plus a "no match" note when nothing scores. Pure, so both heads agree.
 */
export function renderRuntimeResult(args: {
  runtime?: string | undefined
  symptom?: string | undefined
  limit?: number | undefined
}): string {
  const selected = selectRuntimeDifferences(args)
  const scoped = scopedEntries(selected.runtime)
  if (selected.symptom === undefined) return renderIndex(scoped, selected.runtime)
  if (!selected.matched) {
    return `No runtime-difference entry matched "${selected.symptom}"${selected.runtime ? ` for ${selected.runtime}` : ""}.\n\n${renderIndex(scoped, selected.runtime)}`
  }
  return selected.entries.map(renderEntry).join("\n\n")
}
