import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectPortResult,
  detectFeatures,
  FEATURE_IDS,
  FEATURES,
  renderReport,
  resolveTarget,
  scanFileForFeatures,
  TARGETS,
} from "../src/port.ts"

// --- A tiny in-memory scan harness for the pure per-file scanner (no fs) -------------------------------

interface MutScanState {
  evidence: Map<string, { file: string; line: number; snippet: string }[]>
  hasWebSocketHub: boolean
}

const scanOne = (file: string, content: string) => {
  const state: MutScanState = { evidence: new Map(), hasWebSocketHub: false }
  // scanFileForFeatures takes the real ScanState shape; structurally compatible here.
  scanFileForFeatures(file, content, state as never)
  return state
}

const idsWithEvidence = (state: MutScanState): string[] =>
  [...state.evidence.entries()].filter(([, v]) => v.length > 0).map(([k]) => k)

// --- Detection accuracy (the product) -----------------------------------------------------------------

describe("scanFileForFeatures — detects each feature from its real signal", () => {
  test("in-memory-session-store: MemorySessionStore + @nifrajs/auth import", () => {
    const src = [
      'import { MemorySessionStore } from "@nifrajs/auth"',
      "const store = new MemorySessionStore()",
    ].join("\n")
    const state = scanOne("backend.ts", src)
    expect(state.evidence.get("in-memory-session-store")?.map((e) => e.line)).toEqual([1, 2])
  })

  test("in-memory-isr-cache: MemoryCacheStore + @nifrajs/web import", () => {
    const src = [
      'import { createWebApp, MemoryCacheStore } from "@nifrajs/web"',
      "const cache = new MemoryCacheStore()",
    ].join("\n")
    const state = scanOne("server.ts", src)
    expect(state.evidence.get("in-memory-isr-cache")?.map((e) => e.line)).toEqual([1, 2])
  })

  test("in-memory-rate-limit: MemoryStore + @nifrajs/middleware import", () => {
    const src = [
      'import { rateLimit, MemoryStore } from "@nifrajs/middleware"',
      "const store = new MemoryStore()",
    ].join("\n")
    const state = scanOne("backend.ts", src)
    expect(state.evidence.get("in-memory-rate-limit")?.map((e) => e.line)).toEqual([1, 2])
  })

  test("in-process-cron: createScheduler + @nifrajs/cron import", () => {
    const src = [
      'import { createScheduler } from "@nifrajs/cron"',
      'const cron = createScheduler().add("x", "@daily", () => {})',
    ].join("\n")
    const state = scanOne("cron.ts", src)
    // Evidence is the createScheduler() CALL site (line 2), not the import — the call is the usage.
    expect(state.evidence.get("in-process-cron")?.map((e) => e.line)).toEqual([2])
  })

  test("in-process-websocket: app.ws() route is recorded", () => {
    const src = 'const app = server().ws("/chat", { message: (ws, d) => ws.send(d) })'
    const state = scanOne("backend.ts", src)
    expect(state.evidence.get("in-process-websocket")?.map((e) => e.line)).toEqual([1])
    expect(state.hasWebSocketHub).toBe(false)
  })

  test("createWebSocketHub presence is flagged (suppresses the WS hazard at the project level)", () => {
    const src = [
      'import { createWebSocketHub } from "@nifrajs/workers"',
      "export const Hub = createWebSocketHub(app)",
    ].join("\n")
    const state = scanOne("worker.ts", src)
    expect(state.hasWebSocketHub).toBe(true)
  })

  test("bun-runtime-api: Bun.* globals", () => {
    const src = ["Bun.serve({ port: 3000, fetch: app.fetch })", "const f = Bun.file('./x')"].join(
      "\n",
    )
    const state = scanOne("server-bun.ts", src)
    expect(state.evidence.get("bun-runtime-api")?.map((e) => e.line)).toEqual([1, 2])
  })

  test("deno-runtime-api: Deno.* globals", () => {
    const src = "const port = Number(Deno.env.get('PORT') ?? '3000')"
    const state = scanOne("server-deno.ts", src)
    expect(state.evidence.get("deno-runtime-api")?.map((e) => e.line)).toEqual([1])
  })

  test("node-builtin: node:* imports (and require / export-from forms)", () => {
    const src = [
      'import { readFile } from "node:fs/promises"',
      'const crypto = require("node:crypto")',
      'export { x } from "node:util"',
    ].join("\n")
    const state = scanOne("util.ts", src)
    expect(state.evidence.get("node-builtin")?.map((e) => e.line)).toEqual([1, 2, 3])
  })
})

describe("scanFileForFeatures — guards against false positives", () => {
  test("MemorySessionStore WITHOUT @nifrajs/auth import is not flagged (same-named local class)", () => {
    const src = ["class MemorySessionStore {}", "const s = new MemorySessionStore()"].join("\n")
    const state = scanOne("local.ts", src)
    expect(idsWithEvidence(state)).not.toContain("in-memory-session-store")
  })

  test("MemoryStore WITHOUT @nifrajs/middleware is not flagged", () => {
    const src = 'import { MemoryStore } from "./my-local-store"\nnew MemoryStore()'
    const state = scanOne("x.ts", src)
    expect(idsWithEvidence(state)).not.toContain("in-memory-rate-limit")
  })

  test("a signal inside a comment or doc example is stripped, not detected", () => {
    const src = [
      "// import { MemorySessionStore } from '@nifrajs/auth'",
      "/* Bun.serve(...) example */",
      "const doc = `import { createScheduler } from '@nifrajs/cron'`",
    ].join("\n")
    const state = scanOne("doc.ts", src)
    expect(idsWithEvidence(state)).toHaveLength(0)
  })

  test("identifiers merely ending in 'ws' are not WS routes; .fetch / property access not Bun/Deno", () => {
    const src = [
      "const r = rows(1)", // not .ws(
      "renderViews()", // not .ws(
      "myBun.start()", // not Bun.
      "config.Deno.flag", // property access, preceded by '.', not Deno global
    ].join("\n")
    const state = scanOne("x.ts", src)
    expect(state.evidence.get("in-process-websocket") ?? []).toHaveLength(0)
    expect(state.evidence.get("bun-runtime-api") ?? []).toHaveLength(0)
    expect(state.evidence.get("deno-runtime-api") ?? []).toHaveLength(0)
  })

  test("a clean app source produces no findings", () => {
    const src = [
      'import { server } from "@nifrajs/core"',
      'const app = server().get("/", () => ({ ok: true }))',
      "export const backend = app",
    ].join("\n")
    const state = scanOne("backend.ts", src)
    expect(idsWithEvidence(state)).toHaveLength(0)
  })
})

// --- Capability matrix correctness --------------------------------------------------------------------

describe("FEATURES capability matrix", () => {
  test("every feature has a verdict + reason for all five targets", () => {
    for (const id of FEATURE_IDS) {
      const spec = FEATURES[id]
      for (const t of TARGETS) {
        expect(spec.verdicts[t]).toBeDefined()
        expect(typeof spec.reasons[t]).toBe("string")
        expect(spec.reasons[t].length).toBeGreaterThan(0)
      }
    }
  })

  test("in-memory stores: caveat on bun/node/deno, unsupported on cf-pages/vercel", () => {
    for (const id of [
      "in-memory-session-store",
      "in-memory-isr-cache",
      "in-memory-rate-limit",
    ] as const) {
      expect(FEATURES[id].verdicts.bun).toBe("caveat")
      expect(FEATURES[id].verdicts.node).toBe("caveat")
      expect(FEATURES[id].verdicts.deno).toBe("caveat")
      expect(FEATURES[id].verdicts["cf-pages"]).toBe("unsupported")
      expect(FEATURES[id].verdicts.vercel).toBe("unsupported")
    }
  })

  test("in-process-cron: ok on bun/node/deno, caveat on cf-pages, unsupported on vercel", () => {
    expect(FEATURES["in-process-cron"].verdicts.bun).toBe("ok")
    expect(FEATURES["in-process-cron"].verdicts["cf-pages"]).toBe("caveat")
    expect(FEATURES["in-process-cron"].verdicts.vercel).toBe("unsupported")
  })

  test("in-process-websocket: ok on bun/node/deno, caveat on cf-pages, unsupported on vercel", () => {
    expect(FEATURES["in-process-websocket"].verdicts.deno).toBe("ok")
    expect(FEATURES["in-process-websocket"].verdicts["cf-pages"]).toBe("caveat")
    expect(FEATURES["in-process-websocket"].verdicts.vercel).toBe("unsupported")
  })

  test("bun-runtime-api: ok only on bun; deno-runtime-api: ok only on deno", () => {
    expect(FEATURES["bun-runtime-api"].verdicts.bun).toBe("ok")
    for (const t of ["node", "deno", "cf-pages", "vercel"] as const) {
      expect(FEATURES["bun-runtime-api"].verdicts[t]).toBe("unsupported")
    }
    expect(FEATURES["deno-runtime-api"].verdicts.deno).toBe("ok")
    for (const t of ["bun", "node", "cf-pages", "vercel"] as const) {
      expect(FEATURES["deno-runtime-api"].verdicts[t]).toBe("unsupported")
    }
  })

  test("node-builtin: ok on bun/node/deno, caveat on cf-pages + vercel", () => {
    expect(FEATURES["node-builtin"].verdicts.bun).toBe("ok")
    expect(FEATURES["node-builtin"].verdicts.node).toBe("ok")
    expect(FEATURES["node-builtin"].verdicts.deno).toBe("ok")
    expect(FEATURES["node-builtin"].verdicts["cf-pages"]).toBe("caveat")
    expect(FEATURES["node-builtin"].verdicts.vercel).toBe("caveat")
  })
})

// --- Project-level detection + result shaping (real fs fixtures) --------------------------------------

async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-port-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, ".."), { recursive: true })
    await writeFile(abs, content)
  }
  return dir
}

describe("detectFeatures — project walk + WS hub post-pass + ignores", () => {
  test("WS route is detected when no createWebSocketHub exists in the project", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "backend.ts": 'import { server } from "@nifrajs/core"\nconst app = server().ws("/c", {})',
    })
    try {
      const found = await detectFeatures(dir)
      expect(found.map((f) => f.id)).toContain("in-process-websocket")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("WS route is SUPPRESSED when createWebSocketHub is used anywhere in the project", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "backend.ts": 'const app = server().ws("/c", {})',
      "worker.ts":
        'import { createWebSocketHub } from "@nifrajs/workers"\nexport const Hub = createWebSocketHub(app)',
    })
    try {
      const found = await detectFeatures(dir)
      expect(found.map((f) => f.id)).not.toContain("in-process-websocket")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("node_modules, dist*, *.config.*, build*.ts, and tests are excluded from the scan", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "node_modules/x/index.ts":
        'import { MemorySessionStore } from "@nifrajs/auth"\nnew MemorySessionStore()',
      "dist/server.js": "Bun.serve({})",
      "vite.config.ts": "Bun.file('x')",
      "build-bun.ts": "Bun.serve({})",
      "x.test.ts": "Deno.env.get('X')",
    })
    try {
      const found = await detectFeatures(dir)
      expect(found).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("collectPortResult — gating + --json shape", () => {
  test("clean app → portable, no blocks, ok:true, empty features", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app", scripts: { build: "bun run build.ts" } }),
      "backend.ts":
        'import { server } from "@nifrajs/core"\nexport const backend = server().get("/", () => ({ ok: true }))',
    })
    try {
      const result = await collectPortResult(dir, { target: "cf-pages" })
      expect(result.json.ok).toBe(true)
      expect(result.json.features).toHaveLength(0)
      expect(result.json.blocked).toHaveLength(0)
      expect(result.json.target).toBe("cf-pages")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("Bun.* + in-process cron on cf-pages → blocked (unsupported + caveat respectively)", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "server.ts": "Bun.serve({ port: 3000, fetch: app.fetch })",
      "cron.ts": 'import { createScheduler } from "@nifrajs/cron"\ncreateScheduler().start()',
    })
    try {
      const result = await collectPortResult(dir, { target: "cf-pages" })
      const blockedFeatures = result.json.blocked.map((b) => b.feature)
      // Bun.* is unsupported on cf-pages → always blocks.
      expect(blockedFeatures).toContain("bun-runtime-api")
      // in-process-cron is a CAVEAT on cf-pages → NOT blocked without --strict.
      expect(blockedFeatures).not.toContain("in-process-cron")
      expect(result.json.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--strict folds caveats into blocked", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "cron.ts": 'import { createScheduler } from "@nifrajs/cron"\ncreateScheduler().start()',
    })
    try {
      const lenient = await collectPortResult(dir, { target: "cf-pages" })
      expect(lenient.json.blocked).toHaveLength(0)
      expect(lenient.json.ok).toBe(true)

      const strict = await collectPortResult(dir, { target: "cf-pages", strict: true })
      expect(strict.json.blocked.map((b) => b.feature)).toContain("in-process-cron")
      expect(strict.json.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the same Bun.* app is fine on bun (ok) — no blocks", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "server.ts": "Bun.serve({ port: 3000, fetch: app.fetch })",
    })
    try {
      const result = await collectPortResult(dir, { target: "bun" })
      expect(result.json.blocked).toHaveLength(0)
      expect(result.json.ok).toBe(true)
      expect(result.json.features.map((f) => f.id)).toContain("bun-runtime-api")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no resolved target → blocked is empty even with hazards (nothing to gate against)", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "server.ts": "Bun.serve({})",
    })
    try {
      const result = await collectPortResult(dir)
      expect(result.resolved).toBeUndefined()
      expect(result.json.target).toBeNull()
      expect(result.json.features.map((f) => f.id)).toContain("bun-runtime-api")
      expect(result.json.blocked).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--json shape is stable: evidence as file:line strings, verdicts per target", async () => {
    const dir = await makeApp({
      "package.json": JSON.stringify({ name: "app" }),
      "server.ts": "Bun.serve({})",
    })
    try {
      const result = await collectPortResult(dir, { target: "vercel" })
      const feature = result.json.features.find((f) => f.id === "bun-runtime-api")
      expect(feature).toBeDefined()
      expect(feature?.evidence).toEqual(["server.ts:1"])
      expect(Object.keys(feature?.verdicts ?? {}).sort()).toEqual([...TARGETS].sort())
      const block = result.json.blocked.find((b) => b.feature === "bun-runtime-api")
      expect(block?.verdict).toBe("unsupported")
      expect(block?.evidence).toEqual(["server.ts:1"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// --- Target auto-detection ----------------------------------------------------------------------------

describe("resolveTarget — flag override + auto-detection", () => {
  test("--target wins and is validated", async () => {
    const dir = await makeApp({ "package.json": "{}" })
    try {
      expect((await resolveTarget(dir, "deno"))?.target).toBe("deno")
      expect((await resolveTarget(dir, "deno"))?.source).toBe("flag")
      await expect(resolveTarget(dir, "fly")).rejects.toThrow(/invalid --target/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("infers from the build script (create-nifra build-<target>.ts)", async () => {
    const cases: Array<[string, string]> = [
      ["bun run build-vercel.ts", "vercel"],
      ["bun run build-deno.ts", "deno"],
      ["bun run build-node.ts", "node"],
      ["bun run build-bun.ts", "bun"],
    ]
    for (const [build, expected] of cases) {
      const dir = await makeApp({ "package.json": JSON.stringify({ scripts: { build } }) })
      try {
        const resolved = await resolveTarget(dir)
        expect(resolved?.target).toBe(expected as never)
        expect(resolved?.source).toBe("package-json-build")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test("infers cf-pages from the deploy script and from a bare wrangler.toml", async () => {
    const dir1 = await makeApp({
      "package.json": JSON.stringify({ scripts: { deploy: "wrangler pages deploy dist" } }),
    })
    const dir2 = await makeApp({ "package.json": "{}", "wrangler.toml": 'name = "x"' })
    try {
      expect((await resolveTarget(dir1))?.target).toBe("cf-pages")
      expect((await resolveTarget(dir2))?.target).toBe("cf-pages")
      expect((await resolveTarget(dir2))?.source).toBe("wrangler")
    } finally {
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    }
  })

  test("infers vercel from vercel.json; returns undefined when nothing signals", async () => {
    const dir1 = await makeApp({ "package.json": "{}", "vercel.json": "{}" })
    const dir2 = await makeApp({ "package.json": JSON.stringify({ name: "x" }) })
    try {
      expect((await resolveTarget(dir1))?.target).toBe("vercel")
      expect(await resolveTarget(dir2)).toBeUndefined()
    } finally {
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    }
  })
})

// --- Report rendering ---------------------------------------------------------------------------------

describe("renderReport", () => {
  test("clean app prints the all-targets-portable line", async () => {
    const dir = await makeApp({ "package.json": "{}", "backend.ts": "export const x = 1" })
    try {
      const result = await collectPortResult(dir, { target: "cf-pages" })
      const report = renderReport(result, { strict: false })
      expect(report).toContain("portable across all targets")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hazard app prints the matrix, evidence, legend, and blocking detail", async () => {
    const dir = await makeApp({
      "package.json": "{}",
      "server.ts": "Bun.serve({})",
    })
    try {
      const result = await collectPortResult(dir, { target: "cf-pages" })
      const report = renderReport(result, { strict: false })
      expect(report).toContain("portability matrix")
      expect(report).toContain("legend:")
      expect(report).toContain("Bun.* runtime API")
      expect(report).toContain("server.ts:1")
      expect(report).toContain("block deploying to cf-pages")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
