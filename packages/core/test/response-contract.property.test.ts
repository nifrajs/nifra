import { expect, test } from "bun:test"
import fc from "fast-check"
import { type NifraSchema, t } from "../../schema/src/index.ts"
import { server, silentLogger } from "../src/index.ts"
import {
  type ResponseContractReport,
  responseContract,
} from "../src/server/response-contract-lane.ts"

/**
 * The contract judges what `JSON.stringify` writes, so `JSON.stringify` is the oracle. Payloads mix
 * plain values with class instances whose `toJSON` writes from private state, whose own fields are
 * decoys (declared names with wrong values, undeclared names), and whose hook may return another
 * hooked value. Each mode is then held to what the serializer says the payload is.
 */

type Shape =
  | { readonly kind: "string" | "number" | "boolean" | "date" }
  | { readonly kind: "object"; readonly fields: ReadonlyArray<readonly [string, Shape]> }
  | { readonly kind: "array"; readonly item: Shape }

type Node =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "date"; readonly ms: number }
  | { readonly kind: "object"; readonly entries: ReadonlyArray<readonly [string, Node]> }
  | { readonly kind: "array"; readonly items: readonly Node[] }
  | {
      readonly kind: "hooked"
      readonly writes: Node
      readonly decoys: ReadonlyArray<readonly [string, Node]>
    }

const KEYS = ["a", "b", "c", "d"] as const
const UNDECLARED = ["x", "y"] as const

const shapeArb: fc.Arbitrary<Shape> = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom<Shape>(
      { kind: "string" },
      { kind: "number" },
      { kind: "boolean" },
      { kind: "date" },
    ),
    objectShape(tie("shape")),
    tie("shape").map((item): Shape => ({ kind: "array", item })),
  ),
})).shape

function objectShape(field: fc.Arbitrary<Shape>): fc.Arbitrary<Shape> {
  return fc
    .uniqueArray(fc.tuple(fc.constantFrom(...KEYS), field), {
      minLength: 1,
      maxLength: 3,
      selector: ([key]) => key,
    })
    .map((fields): Shape => ({ kind: "object", fields }))
}

const leafArb: fc.Arbitrary<Node> = fc.oneof(
  fc
    .string({ unit: fc.constantFrom(..."ab"), maxLength: 3 })
    .map((value): Node => ({ kind: "string", value })),
  fc.integer({ min: -9, max: 9 }).map((value): Node => ({ kind: "number", value })),
  fc.boolean().map((value): Node => ({ kind: "boolean", value })),
  fc.constant<Node>({ kind: "null" }),
  fc.integer({ min: 0, max: 4e12 }).map((ms): Node => ({ kind: "date", ms })),
)

const decoysArb: fc.Arbitrary<ReadonlyArray<readonly [string, Node]>> = fc.uniqueArray(
  fc.tuple(fc.constantFrom(...KEYS, ...UNDECLARED), leafArb),
  { maxLength: 3, selector: ([key]) => key },
)

/** A value for `shape`: usually one that fits once written, sometimes not, sometimes behind hooks. */
function nodeFor(shape: Shape, depth: number): fc.Arbitrary<Node> {
  const fitting = fitFor(shape, depth)
  const plain = fc.oneof({ arbitrary: fitting, weight: 6 }, { arbitrary: leafArb, weight: 1 })
  // Decoys that fit the schema make a value whose own fields pass while its hook writes others.
  const decoys =
    shape.kind === "object"
      ? fc.oneof(
          decoysArb,
          fitting.map((node) => (node.kind === "object" ? node.entries : [])),
        )
      : decoysArb
  return fc.oneof(
    { arbitrary: plain, weight: 3 },
    {
      arbitrary: fc
        .tuple(plain, decoys, fc.boolean(), decoysArb)
        .map(([writes, decoys, twice, outer]): Node => {
          const hooked: Node = { kind: "hooked", writes, decoys }
          // A hook that returns a hooked value: the serializer writes that value's own fields.
          return twice ? { kind: "hooked", writes: hooked, decoys: outer } : hooked
        }),
      weight: 1,
    },
  )
}

function fitFor(shape: Shape, depth: number): fc.Arbitrary<Node> {
  switch (shape.kind) {
    case "string":
      return fc
        .string({ unit: fc.constantFrom(..."ab"), maxLength: 3 })
        .map((value): Node => ({ kind: "string", value }))
    case "number":
      return fc.integer({ min: -9, max: 9 }).map((value): Node => ({ kind: "number", value }))
    case "boolean":
      return fc.boolean().map((value): Node => ({ kind: "boolean", value }))
    case "date":
      return fc.integer({ min: 0, max: 4e12 }).map((ms): Node => ({ kind: "date", ms }))
    case "array":
      return fc
        .array(nodeFor(shape.item, depth + 1), { maxLength: depth > 2 ? 1 : 3 })
        .map((items): Node => ({ kind: "array", items }))
    case "object": {
      const declared = shape.fields.map(([key, field]) =>
        fc.tuple(
          fc.constant(key),
          nodeFor(field, depth + 1),
          // Now and then a declared field is missing.
          fc.integer({ min: 0, max: 9 }),
        ),
      )
      const extra = fc.uniqueArray(fc.tuple(fc.constantFrom(...UNDECLARED), leafArb), {
        maxLength: 1,
        selector: ([key]) => key,
      })
      return fc.tuple(fc.tuple(...declared), extra).map(
        ([fields, more]): Node => ({
          kind: "object",
          entries: [
            ...fields.filter(([, , keep]) => keep > 0).map(([key, node]) => [key, node] as const),
            ...more,
          ],
        }),
      )
    }
  }
}

let hookCalls: number[] = []

/** A fresh runtime value per call, so the oracle and the route never share a hook's state. */
function build(node: Node): unknown {
  switch (node.kind) {
    case "string":
    case "number":
    case "boolean":
      return node.value
    case "null":
      return null
    case "date":
      return new Date(node.ms)
    case "array":
      return node.items.map(build)
    case "object": {
      const out: Record<string, unknown> = {}
      for (const [key, child] of node.entries) out[key] = build(child)
      return out
    }
    case "hooked": {
      const slot = hookCalls.push(0) - 1
      const written = build(node.writes)
      const instance = new (class Written {
        toJSON() {
          hookCalls[slot] = (hookCalls[slot] ?? 0) + 1
          return written
        }
      })()
      for (const [key, child] of node.decoys) Reflect.set(instance, key, build(child))
      return instance
    }
  }
}

/** What the serializer writes, with each `Date` it writes as itself marked: the contract holds a
 * `Date` to a date schema, so a date and a string with the same text are told apart. A `Date` a
 * hook returns is not one of these; the serializer writes it by its fields, as `{}`. */
function written(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, out: unknown) {
      return this[key] instanceof Date ? { $date: out } : out
    }),
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isDate = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).length === 1 && typeof value.$date === "string"

function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked)
  if (!isRecord(value)) return value
  if (isDate(value)) return value.$date
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unmarked(child)]))
}

function fits(shape: Shape, value: unknown): boolean {
  switch (shape.kind) {
    case "string":
    case "number":
    case "boolean":
      return typeof value === shape.kind
    case "date":
      return isDate(value)
    case "array":
      return Array.isArray(value) && value.every((item) => fits(shape.item, item))
    case "object": {
      if (!isRecord(value) || isDate(value)) return false
      const keys = Object.keys(value)
      return (
        keys.length === shape.fields.length &&
        shape.fields.every(([key, field]) => Object.hasOwn(value, key) && fits(field, value[key]))
      )
    }
  }
}

/** `extra: "strip"` on the written value: an object keeps its declared fields, nothing else changes. */
function stripped(shape: Shape, value: unknown): unknown {
  if (shape.kind === "array")
    return Array.isArray(value) ? value.map((item) => stripped(shape.item, item)) : value
  if (shape.kind !== "object" || !isRecord(value) || isDate(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, field] of shape.fields)
    if (Object.hasOwn(value, key)) out[key] = stripped(field, value[key])
  return out
}

/** The names a stripped-field report gives: paths in what was written but not in what was sent. */
function strippedNames(
  before: unknown,
  after: unknown,
  path: string,
  out: Set<string>,
): Set<string> {
  if (Array.isArray(before)) {
    if (Array.isArray(after))
      for (let i = 0; i < before.length && i < after.length; i++)
        strippedNames(before[i], after[i], `${path}[]`, out)
    return out
  }
  if (!isRecord(before) || !isRecord(after) || isDate(before)) return out
  for (const key of Object.keys(before)) {
    const name = path === "" ? key : `${path}.${key}`
    if (!Object.hasOwn(after, key)) out.add(name)
    else strippedNames(before[key], after[key], name, out)
  }
  return out
}

function schemaOf(shape: Shape): NifraSchema {
  switch (shape.kind) {
    case "string":
      return t.string()
    case "number":
      return t.number()
    case "boolean":
      return t.boolean()
    case "date":
      return t.date()
    case "array":
      return t.array(schemaOf(shape.item))
    case "object":
      return t.object(
        Object.fromEntries(shape.fields.map(([key, field]) => [key, schemaOf(field)])),
      )
  }
}

// A route answers with an object, so the generated contract is one.
const caseArb = objectShape(shapeArb).chain((shape) =>
  nodeFor(shape, 0).map((node) => ({ shape, node })),
)

async function send(
  mode: "warn" | "enforce",
  options: Parameters<typeof responseContract>[1],
  shape: Shape,
  node: Node,
) {
  hookCalls = []
  const app = server({ logger: silentLogger })
    .use(responseContract(mode, options))
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the payload is generated against the schema at run time, which no static type can follow.
    .get("/x", { response: schemaOf(shape) }, () => build(node) as never)
  const res = await app.fetch(new Request("http://t/x"))
  const text = await res.text()
  return {
    status: res.status,
    body: res.status === 200 ? JSON.parse(text) : text,
    calls: hookCalls,
  }
}

const property = { numRuns: 200 } as const

test("property: enforce sends exactly what the serializer writes, or refuses it", async () => {
  await fc.assert(
    fc.asyncProperty(caseArb, async ({ shape, node }) => {
      const oracle = written(build(node))
      const res = await send("enforce", undefined, shape, node)
      if (fits(shape, oracle)) {
        expect(res.status).toBe(200)
        expect(res.body).toEqual(unmarked(oracle))
      } else expect(res.status).toBe(500)
      expect(res.calls.every((calls) => calls <= 1)).toBe(true)
    }),
    property,
  )
})

test("property: strip sends the declared fields of what the serializer writes, or refuses", async () => {
  await fc.assert(
    fc.asyncProperty(caseArb, async ({ shape, node }) => {
      const oracle = written(build(node))
      const kept = stripped(shape, oracle)
      const reports: ResponseContractReport[] = []
      const quiet = { extra: "strip" } as const
      const reported = {
        extra: "strip",
        onReport: (report: ResponseContractReport) => void reports.push(report),
      } as const
      for (const options of [quiet, reported]) {
        const res = await send("enforce", options, shape, node)
        if (fits(shape, kept)) {
          expect(res.status).toBe(200)
          expect(res.body).toEqual(unmarked(kept))
        } else expect(res.status).toBe(500)
        expect(res.calls.every((calls) => calls <= 1)).toBe(true)
      }
      const names = [...strippedNames(oracle, kept, "", new Set())].sort()
      const expected = fits(shape, kept) && names.length > 0 ? [names] : []
      const strips = reports.filter((report) => report.kind === "stripped")
      expect(strips.map((report) => report.fields)).toEqual(expected)
    }),
    property,
  )
})

test("property: warn sends what the serializer writes, and warns exactly when it does not fit", async () => {
  await fc.assert(
    fc.asyncProperty(caseArb, async ({ shape, node }) => {
      const oracle = written(build(node))
      const reports: ResponseContractReport[] = []
      const res = await send(
        "warn",
        { onReport: (report) => void reports.push(report) },
        shape,
        node,
      )
      expect(res.status).toBe(200)
      expect(res.body).toEqual(unmarked(oracle))
      expect(reports.length > 0).toBe(!fits(shape, oracle))
      expect(res.calls.every((calls) => calls <= 1)).toBe(true)
    }),
    property,
  )
})
