import { expect, test } from "bun:test"
import {
  createReferenceContractLabHandler,
  runContractLab,
  runContractLabOverHttp,
  runContractLabThroughAdapter,
} from "../src/contract-lab.ts"

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

test("the over-HTTP runner uses the same witness contract", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const request = input instanceof Request ? input : new Request(String(input))
    return createReferenceContractLabHandler().fetch(request)
  }) as typeof fetch
  try {
    await runContractLabOverHttp("http://nifra-contract-lab.invalid")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("the adapter runner stops a server when a witness fails", async () => {
  let stopped = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.reject(new Error("synthetic fetch failure"))) as unknown as typeof fetch
  try {
    await runContractLabThroughAdapter({
      start: () => ({
        origin: "http://nifra-contract-lab.invalid",
        stop: () => {
          stopped = true
        },
      }),
    }).catch(() => undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(stopped).toBe(true)
})
