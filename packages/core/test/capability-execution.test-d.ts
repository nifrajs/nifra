/** Type-level contract for correlated capability execution and async admission. */
import type { Equal, Expect } from "@nifrajs/test-utils"
import { executeCapability } from "../src/capabilities.ts"
import { server } from "../src/index.ts"

export const _capabilityExecutionApp = server()
  .aroundCapability(async (event, next) => {
    event.effectId satisfies string
    event.signal satisfies AbortSignal
    event.target satisfies string | undefined
    await next()
  })
  .post("/pay", { capabilities: ["payments.charge"] }, async (c) => {
    const result = await executeCapability(
      c,
      "payments.charge",
      { target: "provider:payments" },
      async ({ effectId, signal }) => {
        effectId satisfies string
        signal satisfies AbortSignal
        return { receipt: "created" as const }
      },
    )
    const resultTypeCheck: Expect<Equal<typeof result, { receipt: "created" }>> = true
    void resultTypeCheck
    return result
  })
