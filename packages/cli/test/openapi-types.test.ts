import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { inferOpenAPIResponses } from "../src/openapi-types.ts"

const tempProjects: string[] = []

afterEach(async () => {
  await Promise.all(
    tempProjects.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("inferOpenAPIResponses", () => {
  test("reflects inferred success and status bodies without executing the backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-openapi-types-test-"))
    tempProjects.push(root)
    const repo = resolve(import.meta.dir, "../../..")
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          paths: {
            "@nifrajs/core": [`${repo}/packages/core/src/index.ts`],
            "@nifrajs/core/*": [`${repo}/packages/core/src/*`],
          },
        },
        include: ["backend.ts"],
      }),
      "utf8",
    )
    await writeFile(
      join(root, "backend.ts"),
      [
        'import { server, status } from "@nifrajs/core"',
        "export const backend = server()",
        '  .get("/users/:id", (c) => c.params.id === "missing" ? status(404, { error: "not_found" }) : { id: c.params.id })',
        '  .get("/empty", () => status(204))',
      ].join("\n"),
      "utf8",
    )

    const result = await inferOpenAPIResponses(root)
    expect(result.warnings).toEqual([])
    expect(result.responses["GET /users/:id"]?.["200"]?.schema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    })
    expect(result.responses["GET /users/:id"]?.["404"]?.schema).toEqual({
      type: "object",
      properties: { error: { const: "not_found" } },
      required: ["error"],
    })
    expect(result.responses["GET /empty"]?.["204"]).toEqual({})
  })
})
