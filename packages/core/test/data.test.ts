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

/** Input the types forbid, handed to the runtime on purpose to see what it refuses. */
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the cast only widens a test value to the parameter under test; nothing reads it as `T`.
const wrong = (value: unknown): never => value as never

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

describe("what the data seam refuses", () => {
  const contract = defineDataContract({
    version: "orders.v1",
    operations: { list: { access: "read" } },
  })
  const adapter: TypedDataPort<typeof contract> = { execute: async () => wrong(undefined) }
  const beacon = () => {}

  test("a port needs a contract, an adapter that executes, and an object to bind", () => {
    for (const bad of [null, undefined, "contract", {}]) {
      expect(() => createDataPort(wrong(bad), adapter, { beacon })).toThrow(
        new TypeError("data: contract must be a defineDataContract result"),
      )
    }
    for (const bad of [null, undefined, "adapter", {}, { execute: "run" }]) {
      expect(() => createDataPort(contract, wrong(bad), { beacon })).toThrow(
        new TypeError("data: adapter must implement execute(request)"),
      )
    }
    const port = createDataPort(contract, adapter, { beacon })
    for (const bad of [null, undefined, "context", 7]) {
      expect(() => port.for(wrong(bad))).toThrow(new TypeError("data: context must be an object"))
    }
  })

  test("binding without a beacon fails at for(), before any operation can run", () => {
    let executions = 0
    const port = createDataPort(contract, {
      execute: async () => {
        executions++
        return wrong(undefined)
      },
    })
    expect(() => port.for({})).toThrow("needs a beacon")
    expect(executions).toBe(0)
  })

  test("a contract needs a bounded version, an operations object and read or write access", () => {
    const operations = { list: { access: "read" } } as const
    for (const version of ["", "x".repeat(129), "bad\nversion", 1, undefined]) {
      expect(() => defineDataContract({ version: wrong(version), operations })).toThrow(
        new TypeError("data: version must be a bounded token"),
      )
    }
    for (const bad of [null, undefined, "list"]) {
      expect(() => defineDataContract({ version: "v1", operations: wrong(bad) })).toThrow(
        new TypeError("data: operations must be an object"),
      )
    }
    for (const name of ["1list", "has space", "", "a".repeat(129), "list/all"]) {
      expect(() =>
        defineDataContract({ version: "v1", operations: { [name]: { access: "read" } } }),
      ).toThrow(new TypeError(`data: invalid operation name ${name}`))
    }
    for (const bad of [null, undefined, "read", {}, { access: "admin" }, { access: undefined }]) {
      expect(() => defineDataContract({ version: "v1", operations: { list: wrong(bad) } })).toThrow(
        new TypeError("data: list must declare read or write access"),
      )
    }
    expect(defineDataContract({ version: "x".repeat(128), operations }).version).toHaveLength(128)
    expect(
      Object.keys(
        defineDataContract({ version: "v1", operations: { "A1._x-y": { access: "write" } } })
          .operations,
      ),
    ).toEqual(["A1._x-y"])
  })

  test("drift names a changed version and a changed access, in that order, then added operations", () => {
    const declared = defineDataContract({
      version: "orders.v1",
      operations: { list: { access: "read" }, save: { access: "write" }, gone: { access: "read" } },
    })
    const observed = {
      version: "orders.v2",
      operations: {
        list: { access: "write" },
        save: { access: "write" },
        extra: { access: "read" },
      },
    } as const
    expect(diffDataContract(declared, observed)).toEqual([
      { kind: "version", declaredVersion: "orders.v1", observedVersion: "orders.v2" },
      {
        kind: "access-changed",
        operation: "list",
        declaredAccess: "read",
        observedAccess: "write",
      },
      { kind: "removed", operation: "gone" },
      { kind: "added", operation: "extra" },
    ])
    expect(Object.isFrozen(diffDataContract(declared, observed))).toBe(true)
    expect(diffDataContract(declared, snapshotDataContract(declared))).toEqual([])
    expect(diffDataContract(declared, declared)).toEqual([])
  })

  test("scope tokens and digests are bounded, non-empty strings without control characters", () => {
    const refusal = (label: string) =>
      new TypeError(`data: ${label} must be a bounded opaque token`)
    for (const bad of ["", "x".repeat(257), "bad\u0000token", 7, undefined, null]) {
      expect(() => rlsScope(wrong(bad))).toThrow(refusal("scope token"))
      if (bad !== undefined) {
        expect(() => rlsScope("ok", wrong(bad))).toThrow(refusal("scope digest"))
      }
    }
    expect(rlsScope("x".repeat(256), "y".repeat(256))).toEqual({
      token: "x".repeat(256),
      digest: "y".repeat(256),
    })
    expect(rlsScope("t")).toEqual({ token: "t" })
    expect(Object.isFrozen(rlsScope("t"))).toBe(true)
  })

  test("an observed contract is read through the same snapshot rules as a declared one", () => {
    const declared = defineDataContract({ version: "v1", operations: { list: { access: "read" } } })
    const observed = wrong({
      version: "v1",
      operations: { list: { access: "read" }, odd: { access: "admin" } },
    })
    expect(diffDataContract(declared, observed)).toEqual([])
    const plain = { version: "v1", operations: { list: { access: "read" } } } as const
    expect(diffDataContract(declared, plain)).toEqual([])
  })

  test("a snapshot leaves out an operation whose access is not read or write", () => {
    const loose = wrong({
      version: "orders.v1",
      operations: { list: { access: "read" }, odd: { access: "admin" } },
    })
    expect(snapshotDataContract(loose)).toEqual({
      version: "orders.v1",
      operations: { list: { access: "read" } },
    })
  })
})
