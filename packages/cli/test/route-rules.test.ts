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

describe("NF-C024 overlapping route registration", () => {
  test("flags same-method parameter and static routes with a witness", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/users/:id", () => ({}))', '  .get("/users/me", () => ({}))']),
    )
    const overlaps = findings.filter((f) => f.code === "NF-C024")
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]?.severity).toBe("error")
    expect(overlaps[0]?.message).toContain("witness path: /users/me")
    expect(overlaps[0]?.verify).toBe("nifra check --lints-only")
  })

  test("flags wildcard and nested parameter routes", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/files/*path", () => ({}))', '  .get("/files/:name/edit", () => ({}))']),
    )
    expect(findings.filter((f) => f.code === "NF-C024")).toHaveLength(1)
  })

  test("does not compare different methods or disjoint routes", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/users/:id", () => ({}))',
        '  .post("/users/me", () => ({}))',
        '  .get("/teams/:id", () => ({}))',
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C024")).toEqual([])
  })

  test("supports a route-local suppression pragma", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/users/:id", () => ({}))',
        "  // nifra-expect route-overlap",
        '  .get("/users/me", () => ({}))',
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C024")).toEqual([])
  })

  test("does not crash on malformed route facts", async () => {
    const facts = projectFacts("x", "")
    const findings = await runRuleRegistry(
      {
        root: "/tmp/project",
        sources: facts.source,
        project: {
          ...facts,
          routes: [
            { file: "x", line: 1, method: "GET", path: "users/:id", snippet: "" },
            { file: "x", line: 2, method: "GET", path: "/users/:id", snippet: "" },
          ],
        },
      },
      routeRules,
    )
    expect(findings.filter((f) => f.code === "NF-C024")).toEqual([])
  })
})

describe("optional route params", () => {
  test("NF-C024 reads a trailing optional run as every path it serves", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/users", () => ({}))', '  .get("/users/:id?", () => ({}))']),
    )
    const overlaps = findings.filter((f) => f.code === "NF-C024")
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]?.message).toContain("witness path: /users")
    expect(findings.filter((f) => f.code === "NF-C026")).toEqual([])
  })

  test("NF-C024 stays quiet for a disjoint optional route", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/teams", () => ({}))', '  .get("/users/:id?", () => ({}))']),
    )
    expect(findings.filter((f) => f.code === "NF-C024")).toEqual([])
  })

  test("NF-C019 still reports the same optional route registered twice", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/users/:id?", () => ({}))', '  .get("/users/:id?", () => ({}))']),
    )
    expect(findings.filter((f) => f.code === "NF-C019")).toHaveLength(1)
  })
})

describe("NF-C026 param followed by an unsupported modifier", () => {
  test("supported optional params and ordinary params are quiet", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/users/:id?", () => ({}))',
        '  .get("/d/:year?/:month?", () => ({}))',
        '  .get("/files/:name.json", () => ({}))',
        '  .get("/assets/*path", () => ({}))',
        '  .get("/:lang?", () => ({}))',
      ]),
    )
    expect(findings.filter((f) => f.code === "NF-C026")).toEqual([])
  })

  test("a `?` that is not a trailing whole segment is a warning that names the dead route", async () => {
    const findings = await scan(
      "backend.ts",
      backend(['  .get("/users/:id?/posts", () => ({}))', '  .get("/x/v-:id?", () => ({}))']),
    )
    const found = findings.filter((f) => f.code === "NF-C026")
    expect(found).toHaveLength(2)
    expect(found.every((f) => f.severity === "warn")).toBe(true)
    expect(found[0]?.message).toContain("GET /users/:id?/posts")
    expect(found[0]?.message).toContain("'?' after ':id' is matched as literal text")
    expect(found[0]?.message).toContain("cannot be reached")
    expect(found[0]?.verify).toBe("nifra check --lints-only")
  })

  test("modifiers other routers accept are reported once per route", async () => {
    const findings = await scan(
      "backend.ts",
      backend([
        '  .get("/a/:id+", () => ({}))',
        '  .get("/b/:id*", () => ({}))',
        '  .get("/c/:id{[0-9]+}", () => ({}))',
        '  .get("/d/:id([0-9]+)", () => ({}))',
        '  .get("/e/:id<int>", () => ({}))',
        '  .get("/f/:a+/:b+", () => ({}))',
      ]),
    )
    const found = findings.filter((f) => f.code === "NF-C026")
    expect(found).toHaveLength(6)
    expect(found[0]?.message).toContain("'+' after ':id'")
    expect(found[0]?.message).not.toContain("cannot be reached")
  })

  test("a required param before the optional run is still checked", async () => {
    const findings = await scan("backend.ts", backend(['  .get("/a/:x+/:y?", () => ({}))']))
    expect(findings.filter((f) => f.code === "NF-C026")).toHaveLength(1)
  })

  test("supports a route-local suppression pragma", async () => {
    const findings = await scan(
      "backend.ts",
      backend(["  // nifra-expect param-modifier", '  .get("/math/:a+", () => ({}))']),
    )
    expect(findings.filter((f) => f.code === "NF-C026")).toEqual([])
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
