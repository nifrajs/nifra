import { expect, test } from "bun:test"
import ts from "typescript"
import { apiReferenceDrift, assertSane, generateApiReference } from "./gen-api-reference.ts"

let generated: string | undefined
const reference = (): string => {
  generated ??= generateApiReference()
  return generated
}

test("a committed reference that is missing or differs is stale", () => {
  expect(apiReferenceDrift(undefined, "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("", "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("ref", "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("ref\n", "ref\n")).toBeUndefined()
})

test("an empty or gutted generation is refused before it can match an empty file", () => {
  expect(() => assertSane("")).toThrow("generation looks broken")
  expect(() => assertSane("## @nifrajs/core\n")).toThrow("generation looks broken")
})

test("control: the real generation passes the sanity check", () => {
  expect(() => assertSane(reference())).not.toThrow()
}, 60_000)

// Whether `signature` shows the alias's body: `type Name<...> = ...` rather than its header alone.
const showsBody = (signature: string): boolean => {
  let at = /^type [\w$]+/.exec(signature)?.[0].length ?? 0
  if (signature[at] === "<") {
    for (let depth = 0; at < signature.length; at++) {
      if (signature[at] === "<") depth++
      else if (signature[at] === ">" && --depth === 0) break
    }
    at++
  }
  return signature.startsWith(" = ", at)
}

test("every type signature shown whole parses as TypeScript", () => {
  const broken: string[] = []
  // A signature cut at the length cap ends in an ellipsis and is not meant to parse.
  for (const [, signature = ""] of reference().matchAll(/_\(type\)_ - `(type [^`]*[^…`])`$/gm)) {
    if (!showsBody(signature)) continue
    const { diagnostics = [] } = ts.transpileModule(signature, { reportDiagnostics: true })
    if (diagnostics.length > 0) broken.push(signature)
  }
  expect(broken).toEqual([])
}, 60_000)
