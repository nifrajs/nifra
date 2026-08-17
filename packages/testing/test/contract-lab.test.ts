import { expect, test } from "bun:test"
import { createReferenceContractLabHandler, runContractLab } from "../src/contract-lab.ts"

test("the reference handler satisfies every shared contract witness", async () => {
  await runContractLab(createReferenceContractLabHandler())
})

test("a witness mismatch names the replayable case", async () => {
  await expect(
    runContractLab({
      fetch: () => Response.json({ wrong: true }),
    }),
  ).rejects.toThrow("contract witness params-query-header")
})
