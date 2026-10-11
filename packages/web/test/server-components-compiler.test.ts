import { expect, test } from "bun:test"
import { compileComponentModule } from "../src/server-components/source.ts"

test("a compiler-owned reference contains no server implementation or imports", () => {
  const source =
    'import { defineServerComponent as define } from "@nifrajs/web/server-components"; import { privateValue } from "./private.backend"; export const Summary = define({ authorize(){}, load(){ return privateValue }, view(){ return "fabricated-server-sentinel" } });'
  const client = compileComponentModule(
    source,
    "/fixture/backend/Summary.component.server.ts",
    "/fixture",
    "client",
  )
  const server = compileComponentModule(
    source,
    "/fixture/backend/Summary.component.server.ts",
    "/fixture",
    "ssr",
  )
  expect(client.code).not.toContain("fabricated-server-sentinel")
  expect(client.code).not.toContain("private.backend")
  expect(client.references.Summary).toBe(server.references.Summary)
  expect(server.code).toContain("fabricated-server-sentinel")
  expect(client.code).toContain("Object.freeze")
})

test("the component bridge rejects arbitrary exported values", () => {
  for (const source of [
    "export const privateValue = 'fabricated-private'",
    "export function loadPrivate() {}",
    'export * from "./private.backend"',
    'export default "fabricated-private"',
  ])
    expect(() =>
      compileComponentModule(
        source,
        "/fixture/backend/Invalid.component.server.ts",
        "/fixture",
        "client",
      ),
    ).toThrow()
})
