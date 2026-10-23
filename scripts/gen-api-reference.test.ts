import { expect, test } from "bun:test"
import ts from "typescript"
import {
  apiReferenceDrift,
  assertSane,
  codeSpan,
  generateApiReference,
} from "./gen-api-reference.ts"

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

// Each export line's kind and the signature its code span shows, read off the line as CommonMark reads
// it; `undefined` when the span does not close at the end of the line.
const signatures = (): { readonly kind: string; readonly text: string | undefined }[] =>
  Array.from(reference().matchAll(/^- \*\*[^*]+\*\* _\((\w+)\)_ - (`+)(.*)$/gm), (line) => {
    const [, kind = "", fence = "", rest = ""] = line
    const inner = rest.endsWith(fence) ? rest.slice(0, -fence.length) : undefined
    const closesEarly = (inner?.match(/`+/g) ?? []).some((run) => run.length === fence.length)
    const text =
      inner === undefined || closesEarly
        ? undefined
        : inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== ""
          ? inner.slice(1, -1)
          : inner
    return { kind, text }
  })

test("a code span outruns the backticks inside it and pads one at an edge", () => {
  expect(codeSpan("type A = string")).toBe("`type A = string`")
  expect(codeSpan("type A = `x-${string}`")).toBe("`` type A = `x-${string}` ``")
  expect(codeSpan("a ``b`` c")).toBe("```a ``b`` c```")
})

test("every signature's code span closes at the end of its line, and no comment is in it", () => {
  const lines = signatures()
  expect(lines.length).toBeGreaterThan(1000)
  expect(lines.filter(({ text }) => text === undefined)).toEqual([])
  expect(lines.filter(({ text }) => text?.includes("/*"))).toEqual([])
}, 60_000)

test("every type signature shown whole parses as TypeScript", () => {
  const broken: string[] = []
  for (const { kind, text: signature } of signatures()) {
    // A signature cut at the length cap ends in an ellipsis and is not meant to parse.
    if (kind !== "type" || signature === undefined || signature.endsWith("…")) continue
    if (!showsBody(signature)) continue
    const { diagnostics = [] } = ts.transpileModule(signature, { reportDiagnostics: true })
    if (diagnostics.length > 0) broken.push(signature)
  }
  expect(broken).toEqual([])
}, 60_000)
