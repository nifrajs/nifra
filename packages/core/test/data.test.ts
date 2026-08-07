import { describe, expect, test } from "bun:test"
import type { DataRequestFor, TypedDataPort } from "../src/data.ts"
import {
  createDataPort,
  DATA_CAPABILITIES,
  dataScope,
  defineDataContract,
  diffDataContract,
  rlsScope,
  snapshotDataContract,
} from "../src/data.ts"

describe("typed data seam", () => {
  test("describes token-only operations and detects contract drift", () => {
    const declared = defineDataContract({
      version: "orders.v1",
      operations: {
        list: { access: "read" },
        save: { access: "write" },
      },
    })
    const observed = {
      version: "orders.v1",
      operations: {
        list: { access: "read" },
        archive: { access: "write" },
      },
    } as const

    expect(DATA_CAPABILITIES.read).toBe("db.read")
    expect(snapshotDataContract(declared)).toEqual({
      version: "orders.v1",
      operations: {
        list: { access: "read" },
        save: { access: "write" },
      },
    })
    expect(diffDataContract(declared, observed)).toEqual([
      { kind: "removed", operation: "save" },
      { kind: "added", operation: "archive" },
    ])
  })

  test("constructs an opaque RLS scope without exposing tenant or subject data", () => {
    const scope = rlsScope("request-scope", "scope-digest")
    expect(scope).toEqual({ token: "request-scope", digest: "scope-digest" })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(dataScope("legacy-scope")).toEqual({ token: "legacy-scope" })
    expect(() => rlsScope("bad\nscope")).toThrow(/bounded opaque token/)
  })

  test("keeps runtime contracts token-only even when type witnesses are supplied", () => {
    const contract = defineDataContract({
      version: "orders.v1",
      operations: {
        list: { access: "read", input: { secret: "never-retain" }, output: { rows: 1 } },
      },
    })
    expect(Object.keys(contract.operations.list)).toEqual(["access"])
  })

  test("bound ports emit one capability beacon before executing the adapter", async () => {
    const calls: string[] = []
    const contract = defineDataContract({
      version: "orders.v1",
      operations: {
        list: { access: "read", output: {} as { readonly ids: readonly string[] } },
      },
    })
    const scope = rlsScope("request-scope")
    const adapter = {
      async execute(request: DataRequestFor<typeof contract, "list">) {
        expect(request.scope).toBe(scope)
        return { ids: ["order-1"] }
      },
    } as unknown as TypedDataPort<typeof contract>
    const context = {}
    const port = createDataPort<typeof contract>(contract, adapter, {
      beacon: (_context, capability) => calls.push(capability),
    })

    const result = await port.for(context).execute({
      operation: "list",
      scope,
      capability: "db.read",
    })

    expect(result).toEqual({ ids: ["order-1"] })
    expect(calls).toEqual(["db.read"])
  })

  test("the emitted capability comes from the contract, not from the request", async () => {
    // Types are erased here. A request rebuilt from decoded input could otherwise announce a write
    // as `db.read` and leave the ledger looking satisfied while recording the wrong capability.
    let executions = 0
    const calls: string[] = []
    const contract = defineDataContract({
      version: "orders.v1",
      operations: { save: { access: "write" } },
    })
    const adapter = {
      async execute() {
        executions++
        return undefined
      },
    } as unknown as TypedDataPort<typeof contract>
    const port = createDataPort<typeof contract>(contract, adapter, {
      beacon: (_context, capability) => calls.push(capability),
    })

    await expect(
      port.for({}).execute({
        operation: "save",
        scope: rlsScope("request-scope"),
        capability: "db.read" as never,
      }),
    ).rejects.toThrow("requires db.write")
    expect(calls).toEqual([])
    expect(executions).toBe(0)

    // An operation the contract never declared cannot reach the adapter either.
    await expect(
      port.for({}).execute({
        operation: "drop" as never,
        scope: rlsScope("request-scope"),
        capability: "db.write" as never,
      }),
    ).rejects.toThrow("not declared by this contract")
    expect(executions).toBe(0)
  })

  test("a denied capability prevents the adapter from running", async () => {
    let executions = 0
    const contract = defineDataContract({
      version: "orders.v1",
      operations: { save: { access: "write", output: {} as { readonly ok: true } } },
    })
    const adapter = {
      async execute() {
        executions++
        return { ok: true as const }
      },
    } as unknown as TypedDataPort<typeof contract>
    const port = createDataPort<typeof contract>(contract, adapter, {
      beacon: () => {
        throw new Error("capability denied")
      },
    })

    await expect(
      port.for({}).execute({
        operation: "save",
        scope: rlsScope("request-scope"),
        capability: "db.write",
      }),
    ).rejects.toThrow("capability denied")
    expect(executions).toBe(0)
  })
})
