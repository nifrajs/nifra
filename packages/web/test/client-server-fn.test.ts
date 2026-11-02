import { describe, expect, test } from "bun:test"
import { createServerFnStore } from "../src/fn-state.ts"
import { clientServerFn } from "../src/internal/client-server-fn.ts"

describe("clientServerFn", () => {
  test("is the reference it was handed, typed as the one-argument stub", async () => {
    const stub = async (input: { readonly n: number }) => input.n * 2
    const fn = clientServerFn(stub)
    expect(fn).toBe(stub)
    expect(await createServerFnStore(fn).call({ n: 2 })).toBe(4)
  })
})
