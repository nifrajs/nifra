import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { z } from "zod"
import { runAdversarialContract } from "../src/index.ts"
import { zodJsonSchema } from "../src/zod.ts"

describe("zod reflection bridge", () => {
  test("zodJsonSchema converts a constrained zod object to draft-7 keywords", () => {
    const js = zodJsonSchema(z.object({ name: z.string().min(2), age: z.number().int().min(0) }))
    const properties = (js as { properties?: Record<string, Record<string, unknown>> } | undefined)
      ?.properties
    expect(properties).toBeDefined()
    expect(properties?.name?.minLength).toBe(2)
    expect(properties?.age?.type).toBe("integer")
  })

  test("returns undefined for a non-zod value (fail-safe)", () => {
    expect(zodJsonSchema({ not: "a schema" })).toBeUndefined()
    expect(zodJsonSchema(null)).toBeUndefined()
  })

  test("reflectJsonSchema lights up a zod route: no NO_WITNESS, constraint mutations fire", async () => {
    const app = server().post(
      "/users",
      { body: z.object({ name: z.string().min(2), age: z.number().int().min(0) }) },
      () => ({ ok: true }),
    )
    const report = await runAdversarialContract(app, { seed: 7, reflectJsonSchema: zodJsonSchema })
    expect(report.gaps.filter((gap) => gap.code === "NO_WITNESS")).toHaveLength(0)
    // Proves constraint-driven (not just type-swap) mutations were generated + rejected:
    expect(report.results.some((result) => result.mutation?.includes("below-minLength"))).toBe(true)
    expect(report.results.every((result) => result.ok)).toBe(true)
  })

  test("with NO hook, a zod route lights up automatically (vendor-sniffed default)", async () => {
    // zod is installed here, so the default `autoReflectJsonSchema` recognizes the `~standard.vendor`
    // tag and converts - zero wiring, no NO_WITNESS. This is the out-of-the-box path.
    const app = server().post("/users", { body: z.object({ name: z.string().min(2) }) }, () => ({
      ok: true,
    }))
    const report = await runAdversarialContract(app, { seed: 7 })
    expect(report.gaps.filter((gap) => gap.code === "NO_WITNESS")).toHaveLength(0)
    expect(report.results.some((result) => result.mutation?.includes("below-minLength"))).toBe(true)
  })

  test("an explicit `() => undefined` hook opts out back to opaque (NO_WITNESS)", async () => {
    const app = server().post("/users", { body: z.object({ name: z.string() }) }, () => ({
      ok: true,
    }))
    const report = await runAdversarialContract(app, {
      seed: 7,
      reflectJsonSchema: () => undefined,
    })
    expect(report.gaps.some((gap) => gap.code === "NO_WITNESS")).toBe(true)
  })
})

describe("pattern/refine escalation via authored examples", () => {
  test("an uninvertible regex leaf: `.meta({ examples })` closes the NO_WITNESS gap, no wiring", async () => {
    const app = server().post(
      "/codes",
      {
        body: z.object({
          code: z
            .string()
            .regex(/^[A-Z]{2}-\d{4}$/)
            .meta({ examples: ["AB-1234"] }),
        }),
      },
      () => ({ ok: true }),
    )
    const report = await runAdversarialContract(app, { seed: 7 })
    expect(report.gaps).toHaveLength(0)
    expect(report.results.every((result) => result.ok)).toBe(true)
  })

  test("a `.refine()` allowlist: field examples that satisfy it close the INVALID_WITNESS gap", async () => {
    const app = server().post(
      "/plans",
      {
        body: z
          .object({ plan: z.string().meta({ examples: ["pro"] }) })
          .refine((value) => ["free", "pro"].includes(value.plan)),
      },
      () => ({ ok: true }),
    )
    const report = await runAdversarialContract(app, { seed: 7 })
    expect(report.gaps.filter((gap) => gap.code === "INVALID_WITNESS")).toHaveLength(0)
    expect(report.gaps.filter((gap) => gap.code === "NO_WITNESS")).toHaveLength(0)
  })
})
