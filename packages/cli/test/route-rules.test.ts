import { describe, expect, test } from "bun:test"
import { scanStaticRouteText } from "../src/check.ts"
import { runRuleRegistry } from "../src/rules/index.ts"
import { routeRules } from "../src/rules/routes.ts"
import { projectFacts } from "./rule-facts.ts"

/** Run the route-table rules exactly as `collectCheckResult` wires them: routes come from the
 * static scan of the same source the rules can read back for pragma checks. */
async function scan(file: string, content: string) {
  const facts = projectFacts(file, content, scanStaticRouteText(file, content))
  return runRuleRegistry(
    {
      root: "/tmp/project",
      sources: facts.source,
      project: facts,
    },
    routeRules,
  )
}

const backend = (lines: string[]): string =>
  ['import { server } from "@nifrajs/core"', "const app = server()", ...lines].join("\n")

describe("NF-C018 reserved client segment", () => {
  test("flags a verb-named segment at any depth and any casing", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .post("/api/delete", () => ({}))',
        '  .post("/api/assets/delete", () => ({}))',
        '  .get("/Delete/status", () => ({}))',
      ]),
    )
    const codes = findings.filter((f) => f.code === "NF-C018")
    expect(codes).toHaveLength(3)
    // Advisory, not blocking: the route IS reachable via the typed collision escape.
    expect(codes.every((f) => f.severity === "warn")).toBe(true)
    expect(codes[0]?.message).toContain("reserved client proxy key 'delete'")
    // The message teaches the typed escape spelling for this exact route.
    expect(codes[0]?.message).toContain('api.api("delete")')
  })

  test("flags the exact-match reserved keys: subscribe, ws, index, then", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/jobs/subscribe", () => ({}))',
        '  .get("/socket/ws", () => ({}))',
        '  .get("/legal/index", () => ({}))',
        '  .get("/promise/then", () => ({}))',
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C018")).toHaveLength(4)
  })

  test("never flags params, wildcards, or clean segments", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/users/:id", () => ({}))',
        '  .get("/files/*path", () => ({}))',
        '  .delete("/api/assets", () => ({}))',
        '  .get("/Subscribe/queue", () => ({}))', // exact keys are case-sensitive, like the runtime
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C018")).toEqual([])
  })

  test("the nifra-expect reserved-segment pragma suppresses, from anywhere in the comment block", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        "  // Served only to the external webhook consumer, never the typed client.",
        "  // nifra-expect reserved-segment",
        "  // The path is part of the partner contract and cannot be renamed.",
        '  .post("/hooks/delete", () => ({}))',
        '  .post("/api/delete", () => ({}))', // no pragma - still flagged
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C018")).toHaveLength(1)
  })
})

describe("NF-C019 duplicate route registration", () => {
  test("flags the same method+path twice in one file, pointing at the first", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/health", () => ({}))', '  .get("/health", () => ({ v: 2 }))']),
    )
    const dupes = findings.filter((f) => f.code === "NF-C019")
    expect(dupes).toHaveLength(1)
    expect(dupes[0]?.severity).toBe("error")
    expect(dupes[0]?.message).toContain("GET /health")
  })

  test("different methods on one path, and cross-file same path, are not duplicates", async () => {
    const oneFile = await scan(
      "backend.ts",
      backend(['  .get("/users", () => ({}))', '  .post("/users", () => ({}))']),
    )
    expect(oneFile.filter((f) => f.code === "NF-C019")).toEqual([])

    const a = scanStaticRouteText("apps/a/backend.ts", backend(['  .get("/health", () => ({}))']))
    const b = scanStaticRouteText("apps/b/backend.ts", backend(['  .get("/health", () => ({}))']))
    const facts = projectFacts("apps/a/backend.ts", "", [...a, ...b])
    const crossFile = await runRuleRegistry(
      {
        root: "/tmp/project",
        sources: {
          files: ["apps/a/backend.ts", "apps/b/backend.ts"],
          read: () => "",
        },
        project: {
          ...facts,
          source: {
            files: ["apps/a/backend.ts", "apps/b/backend.ts"],
            read: () => "",
          },
        },
      },
      routeRules,
    )
    expect(crossFile.filter((f) => f.code === "NF-C019")).toEqual([])
  })
})

test("route rules are total over malformed project facts", async () => {
  const facts = projectFacts("x", "")
  const findings = await runRuleRegistry(
    {
      root: "/tmp/project",
      sources: facts.source,
      project: {
        ...facts,
        routes: [null, 42, { file: "x" }, "nope"] as never,
      },
    },
    routeRules,
  )
  expect(findings).toEqual([])
})
