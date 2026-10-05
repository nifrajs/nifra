import { expect, test } from "bun:test"
import { executeCapability, narrowCapabilityContext, useCapability } from "../src/capabilities.ts"
import { server } from "../src/server.ts"

test("a nested context preserves owner admission and blocks capability broadening", async () => {
  const trace: string[] = []
  const app = server()
    .aroundCapability(async (event, next) => {
      trace.push(`${event.method}:${event.path}:${event.capability}`)
      await next()
    })
    .get("/products/:id", { capabilities: ["products.read", "prices.read"] }, async (owner) => {
      const child = narrowCapabilityContext(owner, ["products.read"])
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fabricated ledger captures only the exact records delivered through the public capability observer.
      expect((child as { req: Request }).req).toBe(owner.req)
      expect(() => useCapability(child, "prices.read")).toThrow()
      expect(() => narrowCapabilityContext(child, ["prices.read"])).toThrow()
      const result = await executeCapability(child, "products.read", {}, async ({ signal }) => {
        expect(signal.aborted).toBe(false)
        return { id: owner.params.id }
      })
      return result
    })
  const response = await app.fetch(new Request("https://fixture.test/products/example"))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: "example" })
  expect(trace).toEqual(["GET:/products/:id:products.read"])
})

test("a nested execution cannot introduce a capability on an undeclared owner", () => {
  expect(() =>
    narrowCapabilityContext({ req: new Request("https://fixture.test/") }, ["products.read"]),
  ).toThrow()
})
